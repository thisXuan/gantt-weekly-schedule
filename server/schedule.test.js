import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPlan } from './schedule.js'

const START = '2026-01-05'
const makeRow = (id, type, parentId, durationWeeks, position, extra = {}) => ({
  id,
  type,
  parent_id: parentId,
  name: `${type}-${id}`,
  duration_weeks: durationWeeks,
  manual_start_date: START,
  position,
  depends_on_id: null,
  start_mode: null,
  ...extra,
})

test('an empty chapter uses its manual start and duration', () => {
  const plan = buildPlan([makeRow(1, 'chapter', null, 3, 0)], START)
  const chapter = plan.items[0]

  assert.equal(chapter.startDate, START)
  assert.equal(chapter.endDate, '2026-01-26')
  assert.equal(chapter.durationWeeks, 3)
  assert.equal(plan.totalWeeks, 3)
})

test('an empty group can start after an existing task', () => {
  const plan = buildPlan([
    makeRow(1, 'chapter', null, null, 0),
    makeRow(2, 'section', 1, null, 0),
    makeRow(3, 'task', 2, 2, 0),
    makeRow(4, 'chapter', null, 3, 1, { depends_on_id: 3 }),
  ], START)
  const linkedChapter = plan.items[1]

  assert.equal(linkedChapter.startWeek, 2)
  assert.equal(linkedChapter.endWeek, 5)
})

test('groups span their children without double-counting overlaps', () => {
  const plan = buildPlan([
    makeRow(1, 'chapter', null, 99, 0),
    makeRow(2, 'section', 1, 88, 0),
    makeRow(3, 'task', 2, 2, 0),
    makeRow(4, 'task', 2, 3, 1, { start_mode: 'section_start' }),
    makeRow(5, 'section', 1, 4, 1, { manual_start_date: '2026-02-09' }),
  ], START)
  const chapter = plan.items[0]

  assert.equal(chapter.children[0].children[0].startWeek, 0)
  assert.equal(chapter.children[0].children[1].startWeek, 0)
  assert.equal(chapter.children[0].durationWeeks, 3)
  assert.equal(chapter.children[1].durationWeeks, 4)
  assert.equal(chapter.durationWeeks, 9)
})

test('all durations snap to whole-week boundaries', () => {
  const plan = buildPlan([
    makeRow(1, 'chapter', null, null, 0),
    makeRow(2, 'section', 1, null, 0),
    makeRow(3, 'task', 2, 2.6, 0),
  ], START)
  const task = plan.items[0].children[0].children[0]

  assert.equal(task.durationWeeks, 3)
  assert.equal(task.startWeek, 0)
  assert.equal(task.endWeek, 3)
  assert.equal(plan.items[0].children[0].durationWeeks, 3)
})
