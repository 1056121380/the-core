# The Core

Pure text proactive desktop chat assistant MVP built with Electron, React, TypeScript, and SQLite.

## Tech Stack

- **Framework**: Electron
- **Frontend**: React 18 + TypeScript
- **Build Tool**: electron-vite
- **Database**: sql.js (SQLite)
- **Testing**: Vitest

## Features

- Proactive AI chat assistant
- Memory management
- Topic selection engine
- Dialog management
- Relationship tracking

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Type Check

```bash
npm run typecheck
```

### Test

```bash
npm test
```

## Project Structure

```
src/
├── main/           # Main process
│   ├── engine/     # Core engines
│   ├── services/   # Business logic
│   ├── repositories/# Data access
│   └── config/     # Configuration
├── renderer/       # Renderer process (React)
│   └── src/
│       └── components/
├── preload/        # Preload scripts
└── shared/         # Shared types and utils
```

## License

MIT
