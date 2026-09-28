const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000

export function addWeeks(dateString, weeks) {
  const date = new Date(`${dateString}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + weeks * 7)
  return date.toISOString().slice(0, 10)
}

export function buildPlan(rows, projectStart) {
  const items = rows.map((row) => ({
    id: row.id,
    type: row.type,
    parentId: row.parent_id,
    name: row.name,
    durationWeeks: row.duration_weeks,
    manualStartDate: row.manual_start_date,
    position: row.position,
    dependsOnId: row.depends_on_id,
    startMode: row.start_mode,
    children: [],
  }))
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const item of items) {
    if (item.parentId && byId.has(item.parentId)) byId.get(item.parentId).children.push(item)
  }
  const sortTree = (nodes) => {
    nodes.sort((a, b) => a.position - b.position || a.id - b.id)
    nodes.forEach((node) => sortTree(node.children))
  }
  const roots = items.filter((item) => !item.parentId)
  sortTree(roots)

  const tasks = []
  const visit = (node) => {
    if (node.type === 'task') tasks.push(node)
    node.children.forEach(visit)
  }
  roots.forEach(visit)

  const descendants = (node) => {
    if (!node) return []
    if (node.type === 'task') return [node]
    return node.children.flatMap(descendants)
  }
  const duration = (task) => Math.max(0, Number(task.durationWeeks) || 0)
  const starts = new Array(tasks.length).fill(0)
  const ends = new Array(tasks.length).fill(0)
  const scheduled = new Array(tasks.length).fill(false)

  const taskIndex = new Map(tasks.map((task, index) => [task.id, index]))
  const firstTaskId = (node) => descendants(node)[0]?.id
  const ancestorLinksFor = (task) => {
    const links = []
    let parent = byId.get(task.parentId)
    while (parent) {
      if (parent.dependsOnId) links.push({ id: parent.dependsOnId, isEntry: firstTaskId(parent) === task.id })
      parent = byId.get(parent.parentId)
    }
    return links
  }
  const state = new Array(tasks.length).fill(0)
  const schedule = (index) => {
    if (state[index] === 2) return scheduled[index]
    if (state[index] === 1) throw new Error('The links create a circular schedule. Remove one of the circular links.')
    state[index] = 1
    const task = tasks[index]
    if (!duration(task)) {
      state[index] = 2
      return false
    }
    const ancestorLinks = ancestorLinksFor(task)
    const entryLink = ancestorLinks.find((link) => link.isEntry)?.id
    const baseLink = task.dependsOnId || entryLink
    const usesSectionStart = task.startMode === 'section_start'
    const section = byId.get(task.parentId)
    const usesChapterStart = section?.startMode === 'section_start' && firstTaskId(section) === task.id
    if (!baseLink && !usesSectionStart && !usesChapterStart && index > 0) {
      state[index] = 2
      return false
    }

    const constraintIds = [...new Set([task.dependsOnId, ...ancestorLinks.map((link) => link.id)].filter(Boolean))]
    const constraintEnds = []
    for (const linkedId of constraintIds) {
      const target = byId.get(linkedId)
      if (!target) continue
      if (target.type === 'task') {
        const predecessor = taskIndex.get(target.id)
        if (predecessor === undefined || !schedule(predecessor)) {
          state[index] = 2
          return false
        }
        constraintEnds.push(ends[predecessor])
        continue
      }
      const targetTasks = descendants(target).map((child) => taskIndex.get(child.id)).filter((value) => value !== undefined)
      if (!targetTasks.length) {
        constraintEnds.push(weeksBetween(projectStart, target.manualStartDate || projectStart))
        continue
      }
      targetTasks.forEach(schedule)
      const completedEnds = targetTasks.filter((value) => scheduled[value]).map((value) => ends[value])
      if (!completedEnds.length) {
        state[index] = 2
        return false
      }
      constraintEnds.push(Math.max(...completedEnds))
    }
    let requestedStart = 0
    if (usesSectionStart) {
      const siblingStarts = tasks
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate, candidateIndex }) => candidate.parentId === task.parentId && candidateIndex !== index && state[candidateIndex] === 2 && scheduled[candidateIndex])
        .map(({ candidateIndex }) => starts[candidateIndex])
      requestedStart = siblingStarts.length
        ? Math.min(...siblingStarts)
        : weeksBetween(projectStart, section?.manualStartDate || projectStart)
    }
    if (usesChapterStart) {
      const chapter = byId.get(section?.parentId)
      const chapterStarts = tasks
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate, candidateIndex }) => {
          const candidateSection = byId.get(candidate.parentId)
          return candidateIndex !== index && candidateSection?.parentId === chapter?.id && state[candidateIndex] === 2 && scheduled[candidateIndex]
        })
        .map(({ candidateIndex }) => starts[candidateIndex])
      requestedStart = chapterStarts.length
        ? Math.min(...chapterStarts)
        : weeksBetween(projectStart, chapter?.manualStartDate || projectStart)
    }
    starts[index] = Math.max(requestedStart, ...(constraintEnds.length ? constraintEnds : [0]))
    ends[index] = starts[index] + duration(tasks[index])
    scheduled[index] = true
    state[index] = 2
    return true
  }
  tasks.forEach((_task, index) => schedule(index))

  tasks.forEach((task, index) => {
    task.scheduled = scheduled[index]
    task.startWeek = starts[index]
    task.endWeek = ends[index]
    task.startDate = addWeeks(projectStart, starts[index])
    task.endDate = addWeeks(projectStart, ends[index])
  })

  const summarize = (node) => {
    node.children.forEach(summarize)
    if (node.type !== 'task') {
      const childTasks = descendants(node).filter((task) => task.scheduled)
      if (childTasks.length) {
        node.startWeek = Math.min(...childTasks.map((task) => task.startWeek))
        node.endWeek = Math.max(...childTasks.map((task) => task.endWeek))
        node.durationWeeks = node.endWeek - node.startWeek
        node.startDate = addWeeks(projectStart, node.startWeek)
        node.endDate = addWeeks(projectStart, node.endWeek)
      } else {
        node.durationWeeks = 0
      }
    }
  }
  roots.forEach(summarize)

  const emptyGroupState = new Map()
  const resolveGroupStart = (node) => {
    if (node.durationWeeks > 0) return node.endWeek
    if (emptyGroupState.get(node.id) === 2) return node.endWeek
    if (emptyGroupState.get(node.id) === 1) throw new Error('The links create a circular schedule. Remove one of the circular links.')
    emptyGroupState.set(node.id, 1)
    let startWeek = weeksBetween(projectStart, node.manualStartDate || projectStart)
    const containsTasks = descendants(node).length > 0
    if (node.type === 'section' && node.startMode === 'section_start') {
      const chapter = byId.get(node.parentId)
      startWeek = chapter?.startWeek ?? weeksBetween(projectStart, chapter?.manualStartDate || projectStart)
    }
    if (containsTasks && node.dependsOnId) {
      const target = byId.get(node.dependsOnId)
      if (target?.type === 'task') {
        if (target.scheduled) startWeek = target.endWeek
      } else if (target) {
        startWeek = resolveGroupStart(target)
      }
    }
    node.startWeek = startWeek
    node.endWeek = startWeek
    node.startDate = addWeeks(projectStart, startWeek)
    node.endDate = node.startDate
    emptyGroupState.set(node.id, 2)
    return startWeek
  }
  for (const item of items.filter((candidate) => candidate.type !== 'task')) resolveGroupStart(item)

  // An empty section cannot begin before its chapter. This also normalizes
  // older saved plans that predate the constraint.
  for (const chapter of roots) {
    for (const section of chapter.children.filter((child) => child.type === 'section')) {
      if (section.durationWeeks === 0 && section.startWeek < chapter.startWeek) {
        section.startWeek = chapter.startWeek
        section.endWeek = chapter.startWeek
        section.startDate = chapter.startDate
        section.endDate = chapter.startDate
        section.manualStartDate = chapter.startDate
      }
    }
  }

  // Unscheduled tasks use their section's start as the position of their
  // placeholder. Once linked, their own dependency determines the real dates.
  for (const task of tasks.filter((candidate) => !candidate.scheduled)) {
    const section = byId.get(task.parentId)
    task.startWeek = section?.startWeek ?? 0
    task.endWeek = task.startWeek + duration(task)
    task.startDate = addWeeks(projectStart, task.startWeek)
    task.endDate = addWeeks(projectStart, task.endWeek)
  }

  // Parent ranges always reflect their tasks. Placeholder tasks contribute
  // their duration even though they do not render as scheduled task bars.
  const resummarize = (node) => {
    node.children.forEach(resummarize)
    if (node.type === 'task') return
    const childTasks = descendants(node)
    if (!childTasks.length) return
    node.startWeek = Math.min(...childTasks.map((task) => task.startWeek))
    node.endWeek = Math.max(...childTasks.map((task) => task.endWeek))
    node.durationWeeks = node.endWeek - node.startWeek
    node.startDate = addWeeks(projectStart, node.startWeek)
    node.endDate = addWeeks(projectStart, node.endWeek)
  }
  roots.forEach(resummarize)

  const taskEnds = tasks.map((task) => task.endWeek)
  return { items: roots, totalWeeks: taskEnds.length ? Math.max(...taskEnds) : 0 }
}

export function weeksBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / MS_PER_WEEK)
}
