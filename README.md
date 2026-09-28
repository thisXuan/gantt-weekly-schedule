# Weekline

A local-first weekly planning app that turns a three-level outline into a Gantt chart.

## Features

- Organize work as **chapters → sections → tasks**.
- Give each task a duration in weeks; chapter and section dates are calculated.
- New tasks begin with an empty Weeks placeholder and remain milestone diamonds until a duration is entered.
- Empty chapters and sections use a manually selected start date and appear as milestone diamonds until they contain tasks.
- The first task begins at the plan start date. Later tasks require an explicit finish-to-start link; unlinked tasks appear as placeholder diamonds.
- A task can use **Section start** to begin at the same time as its parent section.
- A section can use **Chapter start** to begin at the same time as its parent chapter.
- Add finish-to-start links with these rules:
  - chapters can link to chapters, sections, or tasks;
  - sections can link to sections or tasks;
  - tasks can link to tasks.
  - chapters and sections cannot link to items contained inside themselves.
- Changes are saved to a local SQLite database in `data/weekline.db`.

## Quick Start

Requires Node.js 22.5 or newer (for the built-in SQLite module).

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The Node API runs at <http://localhost:3001>.

For a single production-style server:

```bash
npm run build
npm start
```

Then open <http://localhost:3001>.
