import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlan } from './schedule.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dataDir = join(root, 'data')
mkdirSync(dataDir, { recursive: true })
const db = new DatabaseSync(join(dataDir, 'weekline.db'))
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('chapter', 'section', 'task')),
    parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    duration_weeks INTEGER CHECK(duration_weeks IS NULL OR duration_weeks > 0),
    manual_start_date TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    depends_on_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
    start_mode TEXT CHECK(start_mode IS NULL OR start_mode = 'section_start')
  );
  INSERT OR IGNORE INTO settings(key, value) VALUES ('project_name', 'My weekly plan');
  INSERT OR IGNORE INTO settings(key, value) VALUES ('start_date', date('now', 'weekday 1', '-7 days'));
`)

const itemColumns = db.prepare('PRAGMA table_info(items)').all().map((column) => column.name)
if (!itemColumns.includes('manual_start_date')) db.exec('ALTER TABLE items ADD COLUMN manual_start_date TEXT')
if (!itemColumns.includes('start_mode')) db.exec("ALTER TABLE items ADD COLUMN start_mode TEXT CHECK(start_mode IS NULL OR start_mode = 'section_start')")

const count = db.prepare('SELECT COUNT(*) AS count FROM items').get().count
if (count === 0) {
  db.exec(`
    INSERT INTO items(type, name, position) VALUES ('chapter', 'Discover', 0);
    INSERT INTO items(type, parent_id, name, position) VALUES ('section', 1, 'Research', 0);
    INSERT INTO items(type, parent_id, name, duration_weeks, position) VALUES ('task', 2, 'Interview users', 2, 0);
    INSERT INTO items(type, parent_id, name, duration_weeks, position) VALUES ('task', 2, 'Synthesize findings', 1, 1);
    INSERT INTO items(type, name, position) VALUES ('chapter', 'Build', 1);
    INSERT INTO items(type, parent_id, name, position) VALUES ('section', 5, 'First release', 0);
    INSERT INTO items(type, parent_id, name, duration_weeks, position) VALUES ('task', 6, 'Create prototype', 3, 0);
    INSERT INTO items(type, parent_id, name, duration_weeks, position) VALUES ('task', 6, 'Test and refine', 2, 1);
  `)
}

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

const body = async (req) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

const settings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]))
const plan = () => {
  const config = settings()
  return { ...config, ...buildPlan(db.prepare('SELECT * FROM items ORDER BY position, id').all(), config.start_date) }
}
const getItem = (id) => db.prepare('SELECT * FROM items WHERE id = ?').get(id)
const undoStack = []
const snapshot = () => ({
  settings: settings(),
  items: db.prepare('SELECT * FROM items ORDER BY id').all(),
})
const remember = (state) => {
  undoStack.push(state)
  if (undoStack.length > 100) undoStack.shift()
}
const restore = (state) => {
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM items')
    const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?')
    Object.entries(state.settings).forEach(([key, value]) => updateSetting.run(value, key))
    const insert = db.prepare(`
      INSERT INTO items(id, type, parent_id, name, duration_weeks, manual_start_date, position, depends_on_id, start_mode)
      VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?)
    `)
    state.items.forEach((item) => insert.run(item.id, item.type, item.name, item.duration_weeks, item.manual_start_date, item.position, item.start_mode))
    const reconnect = db.prepare('UPDATE items SET parent_id = ?, depends_on_id = ? WHERE id = ?')
    state.items.forEach((item) => reconnect.run(item.parent_id, item.depends_on_id, item.id))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
const findPlanItem = (nodes, id) => {
  for (const node of nodes) {
    if (node.id === id) return node
    const child = findPlanItem(node.children, id)
    if (child) return child
  }
}

function validateParent(type, parentId) {
  if (type === 'chapter' && parentId) throw new Error('A chapter cannot have a parent.')
  if (type !== 'chapter' && !parentId) throw new Error(`${type} requires a parent.`)
  if (!parentId) return
  const parent = getItem(parentId)
  if (!parent) throw new Error('Parent not found.')
  if (type === 'section' && parent.type !== 'chapter') throw new Error('A section must be inside a chapter.')
  if (type === 'task' && parent.type !== 'section') throw new Error('A task must be inside a section.')
}

function normalizeDuration(value) {
  const weeks = Number(value)
  if (!Number.isFinite(weeks)) throw new Error('Duration must be a number of weeks.')
  return Math.max(1, Math.round(weeks))
}

function validateLink(item, dependsOnId) {
  if (!dependsOnId) return
  const target = getItem(dependsOnId)
  if (!target) throw new Error('Linked item not found.')
  if (target.id === item.id) throw new Error('An item cannot link to itself.')
  let ancestor = target
  while (ancestor.parent_id) {
    if (ancestor.parent_id === item.id) throw new Error(`A ${item.type} cannot link to an item inside itself.`)
    ancestor = getItem(ancestor.parent_id)
    if (!ancestor) break
  }
  const allowed = {
    chapter: ['chapter', 'section', 'task'],
    section: ['section', 'task'],
    task: ['task'],
  }
  if (!allowed[item.type].includes(target.type)) throw new Error(`A ${item.type} cannot link to a ${target.type}.`)
  const hasChildren = db.prepare('SELECT 1 FROM items WHERE parent_id = ? LIMIT 1').get(item.id)
  if (item.type !== 'task' && !hasChildren && target.type !== 'task') {
    throw new Error(`An empty ${item.type} can only link to a task.`)
  }
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/plan') return json(res, 200, plan())

  if (req.method === 'POST' && url.pathname === '/api/undo') {
    const previous = undoStack.pop()
    if (!previous) return json(res, 409, { error: 'Nothing to undo.' })
    try {
      restore(previous)
      return json(res, 200, plan())
    } catch (error) {
      undoStack.push(previous)
      throw error
    }
  }

  if (req.method === 'PATCH' && url.pathname === '/api/settings') {
    const previous = snapshot()
    const input = await body(req)
    if (input.projectName !== undefined) {
      const name = String(input.projectName).trim()
      if (!name) throw new Error('Project name is required.')
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(name, 'project_name')
    }
    if (input.startDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new Error('Choose a valid start date.')
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(input.startDate, 'start_date')
    }
    const nextPlan = plan()
    remember(previous)
    return json(res, 200, nextPlan)
  }

  if (req.method === 'POST' && url.pathname === '/api/items') {
    const input = await body(req)
    const type = String(input.type)
    if (!['chapter', 'section', 'task'].includes(type)) throw new Error('Invalid item type.')
    const parentId = input.parentId ? Number(input.parentId) : null
    validateParent(type, parentId)
    const name = String(input.name || `New ${type}`).trim()
    const duration = input.durationWeeks
      ? normalizeDuration(input.durationWeeks)
      : null
    const isFirstChild = parentId
      ? db.prepare('SELECT COUNT(*) AS count FROM items WHERE parent_id = ?').get(parentId).count === 0
      : false
    const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM items WHERE parent_id IS ?').get(parentId).next
    const manualStartDate = type === 'task' ? null : settings().start_date
    const startMode = (type === 'task' && input.startMode === 'section_start') || (type === 'section' && input.startMode === 'chapter_start')
      ? 'section_start'
      : null
    const previous = snapshot()
    const result = db.prepare('INSERT INTO items(type, parent_id, name, duration_weeks, manual_start_date, position, start_mode) VALUES (?, ?, ?, ?, ?, ?, ?)').run(type, parentId, name, duration, manualStartDate, position, startMode)
    if (isFirstChild) {
      db.prepare('UPDATE items SET manual_start_date = NULL, depends_on_id = NULL, start_mode = NULL WHERE id = ?').run(parentId)
    }
    const nextPlan = plan()
    remember(previous)
    return json(res, 201, { ...nextPlan, createdId: Number(result.lastInsertRowid) })
  }

  const match = url.pathname.match(/^\/api\/items\/(\d+)$/)
  if (match && req.method === 'PATCH') {
    const id = Number(match[1])
    const current = getItem(id)
    if (!current) return json(res, 404, { error: 'Item not found.' })
    const previous = snapshot()
    const input = await body(req)
    const name = input.name === undefined ? current.name : String(input.name).trim()
    if (!name) throw new Error('Name is required.')
    const duration = input.durationWeeks === undefined
      ? current.duration_weeks
      : (input.durationWeeks === '' || input.durationWeeks === null ? null : normalizeDuration(input.durationWeeks))
    let dependsOnId = input.dependsOnId === undefined ? current.depends_on_id : (input.dependsOnId ? Number(input.dependsOnId) : null)
    let startMode = input.startMode === undefined ? current.start_mode : null
    if (current.type === 'task' && input.startMode === 'section_start') startMode = 'section_start'
    if (current.type === 'section' && input.startMode === 'chapter_start') startMode = 'section_start'
    if (current.type === 'chapter') startMode = null
    if (dependsOnId) startMode = null
    if (startMode === 'section_start') dependsOnId = null
    let manualStartDate = current.type === 'task'
      ? null
      : (input.manualStartDate === undefined ? current.manual_start_date : input.manualStartDate)
    if (manualStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(manualStartDate)) throw new Error('Choose a valid start date.')
    if (current.type === 'section' && manualStartDate) {
      const currentPlan = plan()
      const parent = findPlanItem(currentPlan.items, current.parent_id)
      if (parent && manualStartDate < parent.startDate) manualStartDate = parent.startDate
    }
    validateLink(current, dependsOnId)
    db.prepare('UPDATE items SET name = ?, duration_weeks = ?, manual_start_date = ?, depends_on_id = ?, start_mode = ? WHERE id = ?').run(name, duration, manualStartDate, dependsOnId, startMode, id)
    if (current.type === 'chapter' && manualStartDate) {
      const hasTasks = db.prepare(`
        SELECT 1 FROM items section
        JOIN items task ON task.parent_id = section.id AND task.type = 'task'
        WHERE section.parent_id = ? AND section.type = 'section'
        LIMIT 1
      `).get(id)
      if (!hasTasks) {
        db.prepare(`
          UPDATE items SET manual_start_date = ?
          WHERE type = 'section' AND parent_id = ?
            AND (manual_start_date IS NULL OR manual_start_date < ?)
        `).run(manualStartDate, id, manualStartDate)
      }
    }
    try {
      const nextPlan = plan()
      remember(previous)
      return json(res, 200, nextPlan)
    } catch (error) {
      restore(previous)
      throw error
    }
  }
  if (match && req.method === 'DELETE') {
    const id = Number(match[1])
    if (!getItem(id)) return json(res, 404, { error: 'Item not found.' })
    const previous = snapshot()
    db.prepare('DELETE FROM items WHERE id = ?').run(id)
    const nextPlan = plan()
    remember(previous)
    return json(res, 200, nextPlan)
  }
  return json(res, 404, { error: 'Not found.' })
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    const dist = join(root, 'dist')
    if (!existsSync(dist)) return json(res, 404, { error: 'Client is not built. Run npm run dev or npm run build.' })
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const safePath = resolve(dist, requested)
    const file = safePath.startsWith(dist) && existsSync(safePath) ? safePath : join(dist, 'index.html')
    res.writeHead(200, { 'content-type': `${mime[extname(file)] || 'application/octet-stream'}; charset=utf-8` })
    res.end(readFileSync(file))
  } catch (error) {
    console.error(error)
    json(res, 400, { error: error.message || 'Something went wrong.' })
  }
})

const port = Number(process.env.PORT) || 3001
server.listen(port, () => console.log(`Weekline server running at http://localhost:${port}`))
