import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const WEEK_WIDTH = 64

async function request(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data
}

function flatten(items, collapsed = new Set(), depth = 0) {
  return items.flatMap((item) => [
    { ...item, depth },
    ...(collapsed.has(item.id) ? [] : flatten(item.children, collapsed, depth + 1)),
  ])
}

function findItem(items, id) {
  for (const item of items) {
    if (item.id === id) return item
    const child = findItem(item.children, id)
    if (child) return child
  }
}

const formatDate = (value) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))

function Icon({ name }) {
  const paths = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" /></>,
    calendar: <><path d="M5 3v3M19 3v3M3 9h18M5 5h14a2 2 0 0 1 2 2v13H3V7a2 2 0 0 1 2-2Z" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>
}

function App() {
  const [plan, setPlan] = useState(null)
  const [menuId, setMenuId] = useState(null)
  const [menuAnchor, setMenuAnchor] = useState(null)
  const [collapsed, setCollapsed] = useState(new Set())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const outlineScrollRef = useRef(null)
  const chartScrollRef = useRef(null)

  const load = () => request('/api/plan').then(setPlan).catch((err) => setError(err.message))
  useEffect(() => { load() }, [])

  const rows = useMemo(() => plan ? flatten(plan.items, collapsed) : [], [plan, collapsed])
  const allRows = useMemo(() => plan ? flatten(plan.items) : [], [plan])
  const weeks = Math.max(8, (plan?.totalWeeks || 0) + 2)

  const mutate = async (path, options) => {
    setSaving(true)
    setError('')
    try { setPlan(await request(path, options)) }
    catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  const updateSettings = (patch) => mutate('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) })
  const updateItem = (id, patch) => mutate(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  const toggleCollapsed = (id) => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const syncVerticalScroll = (event, targetRef) => {
    if (targetRef.current && targetRef.current.scrollTop !== event.currentTarget.scrollTop) {
      targetRef.current.scrollTop = event.currentTarget.scrollTop
    }
  }
  const addItem = async (type, parentId = null) => {
    setSaving(true)
    setError('')
    try {
      const data = await request('/api/items', { method: 'POST', body: JSON.stringify({ type, parentId }) })
      setPlan(data)
      setMenuId(null)
      if (parentId) setCollapsed((current) => {
        const next = new Set(current)
        next.delete(parentId)
        return next
      })
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }
  const remove = async (item) => {
    setMenuId(null)
    mutate(`/api/items/${item.id}`, { method: 'DELETE' })
  }

  if (!plan) return <div className="loading"><span /><p>Opening your plan…</p></div>

  return (
    <main onClick={() => setMenuId(null)}>
      <header className="topbar">
        <div className="brand"><div className="brandmark"><Icon name="layers" /></div><span>WEEKLINE <em>Planning Register</em></span></div>
        <div className="project-title">
          <input aria-label="Project name" value={plan.project_name} onChange={(e) => setPlan({ ...plan, project_name: e.target.value })} onBlur={(e) => updateSettings({ projectName: e.target.value })} />
          <span>{plan.totalWeeks} week plan</span>
        </div>
        <div className="start-control">
          <Icon name="calendar" />
          <label>Plan starts<input type="date" value={plan.start_date} onChange={(e) => updateSettings({ startDate: e.target.value })} /></label>
        </div>
      </header>

      {error && <div className="error"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}

      <section className="workspace" aria-busy={saving}>
        <aside className="outline">
          <div className="panel-heading">
            <div><span className="eyebrow">WORK BREAKDOWN</span><h2>Plan outline</h2></div>
            <button className="add-main" onClick={() => addItem('chapter')}><Icon name="plus" /> Add chapter</button>
          </div>
          <div className="column-head"><span>Work item</span><span>Weeks</span></div>
          <div className="outline-rows" ref={outlineScrollRef} onScroll={(event) => syncVerticalScroll(event, chartScrollRef)}>
            {rows.length === 0 && <div className="empty">Start by adding a chapter.</div>}
            {rows.map((item) => (
              <div key={item.id} className={`outline-row ${item.type} ${menuId === item.id ? 'menu-open' : ''}`}>
                <div className="item-name" style={{ paddingLeft: 16 + item.depth * 22 }}>
                  {item.type === 'task'
                    ? <span className="type-mark">•</span>
                    : <button className={`disclosure ${collapsed.has(item.id) ? 'collapsed' : ''}`} aria-label={`${collapsed.has(item.id) ? 'Show' : 'Hide'} ${item.name} contents`} onClick={() => toggleCollapsed(item.id)}><Icon name="chevron" /></button>}
                  <input value={item.name} aria-label={`${item.type} name`} onClick={(e) => e.stopPropagation()} onChange={(e) => {
                    const next = structuredClone(plan)
                    const target = findItem(next.items, item.id)
                    target.name = e.target.value
                    setPlan(next)
                  }} onBlur={(e) => updateItem(item.id, { name: e.target.value })} />
                  <div className="row-actions">
                    {item.type !== 'task' && <button className="child-button" aria-label={`Add child to ${item.name}`} onClick={(e) => { e.stopPropagation(); addItem(item.type === 'chapter' ? 'section' : 'task', item.id) }}><Icon name="plus" /></button>}
                    <button className="more-button" aria-label={`Set schedule for ${item.name}`} onClick={(e) => {
                      e.stopPropagation()
                      if (menuId === item.id) {
                        setMenuId(null)
                        setMenuAnchor(null)
                        return
                      }
                      const rect = e.currentTarget.getBoundingClientRect()
                      const viewport = e.currentTarget.ownerDocument.documentElement
                      setMenuAnchor({
                        target: e.currentTarget.ownerDocument.body,
                        left: Math.min(rect.right + 8, viewport.clientWidth - 308),
                        top: rect.bottom + 6,
                        bottom: viewport.clientHeight - rect.top + 6,
                        openUp: viewport.clientHeight - rect.bottom < 340,
                      })
                      setMenuId(item.id)
                    }}><span>•••</span></button>
                  </div>
                  {menuId === item.id && menuAnchor && createPortal(<InlineMenu item={item} rows={allRows} anchor={menuAnchor} onUpdate={(patch) => updateItem(item.id, patch)} onDelete={() => remove(item)} onClose={() => { setMenuId(null); setMenuAnchor(null) }} />, menuAnchor.target)}
                </div>
                <div className="duration-cell">
                  {item.type === 'task' || item.children.length === 0 ? <input type="number" min="1" value={item.durationWeeks ?? ''} placeholder="—" aria-label={`${item.type} duration in weeks`} onClick={(e) => e.stopPropagation()} onChange={(e) => updateItem(item.id, { durationWeeks: e.target.value })} /> : <span>{item.durationWeeks}</span>}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <section className="timeline">
          <div className="timeline-top">
            <div><span className="eyebrow">SCHEDULE</span><h2>Weekly programme</h2></div>
            <div className="legend"><i className="chapter-key" />Chapter <i className="section-key" />Section <i className="task-key" />Task</div>
          </div>
          <div className="chart-scroll" ref={chartScrollRef} onScroll={(event) => syncVerticalScroll(event, outlineScrollRef)}>
            <div className="chart" style={{ width: weeks * WEEK_WIDTH }}>
              <div className="week-header">
                {Array.from({ length: weeks }, (_, index) => <div key={index}><b>W{index + 1}</b><span>{formatDate(new Date(Date.parse(`${plan.start_date}T00:00:00Z`) + index * 604800000).toISOString().slice(0, 10))}</span></div>)}
              </div>
              <div className="grid-lines">{Array.from({ length: weeks }, (_, index) => <i key={index} />)}</div>
              <div className="bars">
                {rows.map((item) => <div key={item.id} className="bar-row">
                  {item.durationWeeks > 0 && item.scheduled !== false && <div className={`bar ${item.type}`} style={{ left: item.startWeek * WEEK_WIDTH + 5, width: Math.max(item.durationWeeks * WEEK_WIDTH - 10, 14) }} title={`${item.name}: ${item.startDate} to ${item.endDate}`}>
                    <span>{item.name}</span>{item.type === 'task' && <small>{item.durationWeeks}w</small>}
                  </div>}
                  {((item.type !== 'task' && !item.durationWeeks) || (item.type === 'task' && item.scheduled === false)) && <div className={`empty-marker ${item.type}`} style={{ left: item.startWeek * WEEK_WIDTH + 25 }} title={item.type === 'task' ? `${item.name}: choose a predecessor` : `${item.name}: starts ${item.startDate}`}><span /></div>}
                </div>)}
              </div>
            </div>
          </div>
        </section>
      </section>

      <footer className="statusbar">
        <div><span className={saving ? 'saving dot' : 'dot'} />{saving ? 'Saving…' : 'Saved to local archive'}</div>
        <div>{allRows.filter((row) => row.type === 'task').length} tasks · {plan.totalWeeks} weeks · ends {plan.totalWeeks ? formatDate(new Date(Date.parse(`${plan.start_date}T00:00:00Z`) + plan.totalWeeks * 604800000).toISOString().slice(0, 10)) : '—'}</div>
      </footer>

    </main>
  )
}

function InlineMenu({ item, rows, anchor, onUpdate, onDelete, onClose }) {
  const allowedTypes = item.type === 'chapter' ? ['chapter', 'section', 'task'] : item.type === 'section' ? ['section', 'task'] : ['task']
  const rowById = new Map(rows.map((row) => [row.id, row]))
  const isInsideItem = (candidate) => {
    let parent = rowById.get(candidate.parentId)
    while (parent) {
      if (parent.id === item.id) return true
      parent = rowById.get(parent.parentId)
    }
    return false
  }
  const isLeafGroup = item.type !== 'task' && item.children.length === 0
  const options = rows.filter((row) => row.id !== item.id && (isLeafGroup ? row.type === 'task' : allowedTypes.includes(row.type)) && !isInsideItem(row))
  const isFirstTask = item.type === 'task' && rows.find((row) => row.type === 'task')?.id === item.id
  const parentStartOption = item.type === 'task' ? '__section_start__' : item.type === 'section' ? '__chapter_start__' : null
  const startAfterValue = item.startMode === 'section_start' && parentStartOption ? parentStartOption : (item.dependsOnId || '')
  const updateStartAfter = (value) => {
    if (value === '__section_start__') return onUpdate({ startMode: 'section_start', dependsOnId: null })
    if (value === '__chapter_start__') return onUpdate({ startMode: 'chapter_start', dependsOnId: null })
    return onUpdate({ startMode: null, dependsOnId: value || null })
  }
  const position = anchor.openUp ? { left: anchor.left, bottom: anchor.bottom } : { left: anchor.left, top: anchor.top }
  return <div className={`inline-menu ${anchor.openUp ? 'open-up' : ''}`} style={position} onClick={(e) => e.stopPropagation()}>
    <div className="inline-menu-head"><div><span>{item.type}</span><b>{item.name}</b></div><button aria-label="Close" onClick={onClose}>×</button></div>
    <div className="inline-dates">{item.type === 'task' && item.scheduled === false ? <span className="unscheduled-label">Not scheduled</span> : <><span>{formatDate(item.startDate)}</span><i>→</i><span>{formatDate(item.endDate)}</span><em>{item.durationWeeks || 0}w</em></>}</div>
    {isLeafGroup && <>
      <label className="field"><span><Icon name="link" />Start method</span><select value={item.dependsOnId || ''} onChange={(e) => onUpdate({ dependsOnId: e.target.value || null })}><option value="">Concrete date</option>{options.map((option) => <option key={option.id} value={option.id}>After task · {option.name}</option>)}</select></label>
      {!item.dependsOnId && <label className="field manual-date"><span><Icon name="calendar" />Concrete start date</span><input type="date" value={item.manualStartDate || item.startDate} onChange={(e) => onUpdate({ manualStartDate: e.target.value, dependsOnId: null })} /><small>{`Used while this ${item.type} has no children.`}</small></label>}
    </>}
    {!isLeafGroup && <label className="field"><span><Icon name="link" />Starts after</span><select value={startAfterValue} onChange={(e) => updateStartAfter(e.target.value)}><option value="">{isFirstTask ? 'Plan start' : item.type === 'task' ? 'Not scheduled' : 'No link'}</option>{item.type === 'task' && <option value="__section_start__">Section start</option>}{item.type === 'section' && <option value="__chapter_start__">Chapter start</option>}{options.map((option) => <option key={option.id} value={option.id}>{option.type} · {option.name}</option>)}</select></label>}
    <button className="inline-delete" onClick={onDelete}><Icon name="trash" />Delete {item.type}</button>
  </div>
}

export default App
