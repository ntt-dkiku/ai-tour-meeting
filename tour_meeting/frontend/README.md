# Frontend Architecture

This document records the frontend structure after the App.tsx refactoring.

## Table of Contents

1. [Directory Structure](#directory-structure)
2. [Architecture Overview](#architecture-overview)
3. [Custom Hooks](#custom-hooks)
4. [Context](#context)
5. [Utilities](#utilities)
6. [Component Structure](#component-structure)
7. [App.tsx State Management](#apptsx-state-management)
8. [Data Flow](#data-flow)
9. [Refactoring History](#refactoring-history)
10. [Testing](#-testing)
11. [Type Definitions](#type-definitions-typesindexts)

---

## Directory Structure

```
src/
├── App.tsx                  # Main component (~3,914 lines)
├── main.tsx                 # Entry point
├── context/
│   └── MeetingContext.tsx   # Global settings state management
├── hooks/
│   ├── useChatState.ts      # Chat/meeting state
│   ├── useApiKeys.ts        # API key management
│   ├── useParticipants.ts   # Participant CRUD
│   ├── useMeetingLogs.ts    # Logs/timer/history management
│   ├── useLocalStorage.ts   # localStorage sync
│   └── useWebSocket.ts      # WebSocket connection (not yet integrated)
├── utils/
│   ├── helpers.ts           # Key generation, log entry operations
│   ├── parsing.ts           # Number parsing functions
│   ├── meetingSync.ts       # Meeting data merge
│   ├── formatting.ts        # Formatting functions
│   └── textProcessing.ts    # Text processing
├── types/
│   └── index.ts             # Type definitions
├── constants/
│   └── index.ts             # Constants, default values
└── components/
    ├── views/               # 3 main views
    │   ├── SettingsView.tsx
    │   ├── MeetingView.tsx
    │   └── StatisticsView.tsx
    ├── settings/            # Settings screen components
    ├── meeting/             # Meeting screen components
    └── ui/                  # Generic UI components
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        MeetingProvider                       │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                         App.tsx                          ││
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     ││
│  │  │ useChatState │ │useParticipants│ │useMeetingLogs│     ││
│  │  └──────────────┘ └──────────────┘ └──────────────┘     ││
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     ││
│  │  │ useApiKeys   │ │useLocalStorage│ │useMeetingCtx │     ││
│  │  └──────────────┘ └──────────────┘ └──────────────┘     ││
│  │                                                          ││
│  │  ┌─────────────────────────────────────────────────────┐││
│  │  │  View: settings | meeting | statistics              │││
│  │  │  ┌─────────────┐┌─────────────┐┌──────────────┐    │││
│  │  │  │SettingsView ││ MeetingView ││StatisticsView│    │││
│  │  │  └─────────────┘└─────────────┘└──────────────┘    │││
│  │  └─────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## Custom Hooks

### 1. useChatState (`hooks/useChatState.ts`)

**Responsibility**: Chat screen state management

```typescript
interface ChatState {
  logs: LogEntry[];           // Chat logs
  connected: boolean;         // WebSocket connection status
  status: string;             // Meeting status (idle/running/stopped etc)
  userMessage: string;        // User input
  needModification: boolean;  // Modification request flag
  waitingForUser: boolean;    // Waiting for user input
  waitingForVote: boolean;    // Waiting for vote
  votingData: any;            // Voting data
  expandedInternalLogs: Record<string, boolean>;   // Internal log expansion state
  expandedObservations: Record<string, boolean>;   // Observation log expansion state
}
```

**Dependencies**: None (standalone hook)

---

### 2. useParticipants (`hooks/useParticipants.ts`)

**Responsibility**: Participant CRUD operations

```typescript
interface UseParticipantsOptions {
  apiBase: string;
  currentMeetingId: string | null;
}

// Provided features
- participants, order: Participant list and order
- includeHuman: Human participation flag
- form, editingParticipant: Modal state
- refreshParticipants(): Fetch from API
- addParticipant(): Add/update
- deleteParticipant(name): Delete
- removeAllParticipants(): Delete all
- downloadParticipants(): JSON download
- handleParticipantsDrop(): Drag & drop import
```

**Dependencies**: `apiBase`, `currentMeetingId`

---

### 3. useMeetingLogs (`hooks/useMeetingLogs.ts`)

**Responsibility**: Log management, elapsed time, history persistence

```typescript
interface UseMeetingLogsOptions {
  currentMeetingId: string | null;
  logs: LogEntry[];
  setLogs: Dispatch<SetStateAction<LogEntry[]>>;
  meetingHistory: MeetingHistory;
  setMeetingHistory: Dispatch<SetStateAction<MeetingHistory>>;
  expandedInternalLogs: Record<string, boolean>;
  setExpandedInternalLogs: Dispatch<SetStateAction<Record<string, boolean>>>;
  meetings: { id: string; status?: string }[];
  status: string;
}

// Provided features
- elapsedSeconds, nowSeconds: Elapsed time
- meetingStartRef, meetingResumeOffsetRef: Timer management refs
- tickElapsed(): Timer update
- upsertMessage(): Add/update message
- upsertRoutePlan(): Update route plan
- handleInternalEvent(): Internal event processing
- toggleInternalLog(): Toggle log expansion
- appendPhaseLog(): Add phase log
- appendInvitationMessage(): Add invitation message
```

**Dependencies**: Receives state from `useChatState`

---

### 4. useApiKeys (`hooks/useApiKeys.ts`)

**Responsibility**: API key configuration and validation

```typescript
// Provided features
- apiKeyStatus: Configuration status for each provider
- apiKeyInputs: Input values
- handleApiKeySave(provider): Save and validate
- fetchApiKeyStatus(): Fetch status
```

**Dependencies**: `apiBase`

---

### 5. useLocalStorage (`hooks/useLocalStorage.ts`)

**Responsibility**: localStorage synchronization

```typescript
function useLocalStorage<T>(
  key: string,
  initialValue: T,
  options?: { debounceMs?: number }
): [T, React.Dispatch<React.SetStateAction<T>>]
```

**Features**:
- Lazy initialization (reads from localStorage only once on mount)
- Auto-save on value change
- Optional debounce support
- SSR-safe (skips when window is undefined)

**Usage**: `meetingHistory` persistence

---

## Context

### MeetingContext (`context/MeetingContext.tsx`)

**Responsibility**: Global state management for meeting settings

```typescript
interface MeetingSettings {
  globalGoals: string;
  maxTurns: number;
  timeLimit: string;
  travelDate: string;
  timeWindowStart: string;
  timeWindowEnd: string;
  budget: string;
  draftWorkflow: string;
  turnRule: string;
  votingTurnRule: string;
  draftVotingRule: string;
  secondaryVotingRule: string;
  refinementWorkflow: string;
  refinementTurnRule: string;
  refinementConsensusRule: string;
  refinementBatchSize: string;
  refinementMajorityThreshold: string;
  refinementPleasureThreshold: string;
  refinementMiseryThreshold: string;
  refinementConsensusDecider: string;
}
```

**Main features**:
- `settings`: Current UI values
- `updateSetting(key, value)`: Update single setting
- `settingsCacheRef`: Per-meeting settings cache (ref)
- `loadSettingsFromCache(meetingId)`: Restore UI state from cache
- `saveSettingsToCache(meetingId)`: Save UI state to cache

**Field name mapping**:
- Cache: `workflow`, `votingRule`
- Settings: `draftWorkflow`, `draftVotingRule`

---

## Utilities

### helpers.ts

```typescript
// Key generation
normalizeNameForKey(name): string      // Normalize name
buildInternalKey(turn, speaker): string // Generate internal log key
buildExpandedStorageKey(meetingId): string

// Log entry operations
isMessageEntry(entry): entry is MessageOut
findLastMessageEntry(entries): MessageOut | null
countMessagesWithTurn(entries, turn): number
buildInvitationMessageEntry(...): MessageOut
parseInvitationPhasePayload(title, description, fallback): {...} | null
```

### parsing.ts

```typescript
parsePositiveInt(raw): number | null    // Parse positive integer
parseNumeric(raw): number | null        // Parse number
toNumber(value, fallback): number       // Convert to number with fallback
clamp01(value): number                  // Clamp to 0-1
isActiveStatus(status): boolean         // Check if running/stopping
```

### meetingSync.ts

```typescript
mergeMeetingData(current: MeetingInfo, data: Partial<MeetingInfo>): MeetingInfo
```

Merges API response into existing MeetingInfo. Type-safely handles string/number/nullable fields.

---

## Component Structure

### Views (View switching)

| View | Component | Description |
|------|-----------|-------------|
| settings | `SettingsView` | Meeting settings screen |
| meeting | `MeetingView` | Chat screen |
| statistics | `StatisticsView` | Statistics/analytics screen |

### SettingsView Composition

```
SettingsView
├── SettingsHeader        # Header (start button, etc.)
├── TitleSection          # Title editing
├── ParticipantsSection   # Participant management
├── GoalsSection          # Goal settings
├── ConstraintsSection    # Constraint settings
├── WorkflowSection       # Workflow settings
├── DragOverlay           # Drag overlay
└── LoadingOverlay        # Loading indicator
```

### MeetingView Composition

```
MeetingView
├── MeetingHeader        # Header (stop/resume, etc.)
├── ChatMessages         # Chat log display
├── UserInputSection     # User input/voting
└── ScrollGradient       # Scroll UI
```

---

## App.tsx State Management

### Local State (useState)

| State | Type | Description |
|-------|------|-------------|
| `apiBase` | string | API base URL |
| `meetings` | MeetingInfo[] | Meeting list |
| `currentMeetingId` | string \| null | Selected meeting |
| `meetingTitle` | string | Current title |
| `meetingHistory` | MeetingHistory | Log history (localStorage persisted) |
| `contextMenu` | ContextMenuState \| null | Right-click menu |
| `isEditingTitle` | boolean | Title editing mode |
| `isSidebarOpen` | boolean | Sidebar open/close |
| `startedMeetings` | Record<string, boolean> | Started meetings |
| `view` | "settings" \| "meeting" \| "statistics" | Current view |
| `isGeneratingSample` | boolean | Sample generation in progress |
| `autoScroll` | boolean | Auto scroll |
| `showScrollButton` | boolean | Scroll button visibility |
| `isDragOverSettings` | boolean | Drag over state |

### Refs

| Ref | Purpose |
|-----|---------|
| `logsEndRef` | Scroll to chat end |
| `chatContainerRef` | Chat container |
| `fileInputRef` | File input |
| `manualDisconnectRef` | Manual disconnect flag |
| `goalCacheRef` | Goal cache |
| `routeScrollPositionsRef` | Route display scroll positions |

### Main Callbacks

| Function | Description |
|----------|-------------|
| `loadMeetings` | Load meeting list |
| `startMeetingWS` | Start WebSocket connection |
| `handleResetMeeting` | Reset meeting |
| `downloadMeetingSettings` | Download settings JSON |
| `handleMeetingSettingsImport` | Import settings JSON |
| `handleChatScroll` | Scroll handling |
| `scrollToBottom` | Scroll to bottom |
| `goToHome` | Go to home screen |

---

## Data Flow

### 1. Meeting Selection

```
selectMeeting(id)
  ↓
setCurrentMeetingId(id)
  ↓
useEffect [currentMeetingId]
  ↓
┌─ fetch /meetings/{id} → setMeetings (mergeMeetingData)
├─ fetch /meetings/{id}/participants → setParticipants
├─ fetch /meetings/{id}/order → setOrder
└─ loadSettingsFromCache(id) → restore settings
```

### 2. WebSocket Message Processing

```
WebSocket.onmessage
  ↓
switch(data.type)
  ├─ "turn_start" → Create new message
  ├─ "delta" → upsertMessage (append text)
  ├─ "turn_final" → upsertMessage (finalize)
  ├─ "phase_message" → appendPhaseLog / appendInvitationMessage
  ├─ "route_plan_update" → upsertRoutePlan
  ├─ "status" → setStatus, update setMeetings
  ├─ "human_turn" → setWaitingForUser(true)
  ├─ "human_vote" → setWaitingForVote(true), setVotingData
  └─ "meeting_finished" → Completion processing
```

### 3. Log Persistence

```
logs change
  ↓
useEffect in useMeetingLogs
  ↓
setMeetingHistory({ [currentMeetingId]: logs })
  ↓
useLocalStorage
  ↓
localStorage.setItem(MEETING_HISTORY_STORAGE_KEY, JSON.stringify(meetingHistory))
```

---

## Refactoring History

| Date | Commit | Description | Lines Reduced |
|------|--------|-------------|---------------|
| - | - | useChatState hook | - |
| - | - | useApiKeys hook | - |
| - | - | useParticipants hook | ~320 lines |
| - | - | useMeetingLogs hook | ~280 lines |
| - | - | View components extraction | ~200 lines |
| - | ab545b4 | Simplify setting setters + parsing.ts | ~38 lines |
| - | 0ece142 | useLocalStorage + meetingSync | ~108 lines |

**Total reduction**: 7,179 lines → 3,914 lines (~45% reduction)

---

## Future Improvement Candidates

1. **Meeting Lifecycle Hook**: Consolidate createMeeting, deleteMeeting, selectMeeting, etc.
2. **File Operations Hook**: Consolidate file operations (high complexity)
3. **useWebSocket Integration**: Integrate the currently unintegrated WebSocket hook into App.tsx

---

## 🧪 Testing

> **Note**: Backend (Python) tests are located in the project root `tests/` directory. See [Backend Testing Documentation](../../tests/README.md) for details.

### Test Stack

- **Test Runner**: [Vitest](https://vitest.dev/) v2.0.0
- **Testing Library**: [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/) v16.0.0
- **DOM Environment**: jsdom v24.0.0
- **Assertion Extensions**: @testing-library/jest-dom v6.4.0

### Running Tests

```bash
# From project root (via Docker)
make test-frontend           # Run all tests once
make test-frontend-watch     # Run tests in watch mode (for development)
make test-frontend-coverage  # Run tests with coverage report

# From frontend directory (local)
npm test            # Run all tests once
npm run test:watch  # Run tests in watch mode
npm run test:coverage # Run tests with coverage
```

### Test Directory Structure

```
src/__tests__/
├── setup.ts                    # Test setup (mocks for localStorage, fetch)
├── utils/
│   ├── formatting.test.ts      # Time/content formatting
│   ├── helpers.test.ts         # Key generation, log operations
│   ├── meetingSync.test.ts     # Meeting data merge
│   ├── parsing.test.ts         # Number parsing
│   └── textProcessing.test.ts  # Text normalization
├── hooks/
│   ├── useChatState.test.ts    # Chat state management
│   ├── useLocalStorage.test.ts # localStorage sync
│   ├── useMeetingLogs.test.ts  # Logs/timer management
│   └── useParticipants.test.ts # Participant CRUD
├── context/
│   └── MeetingContext.test.tsx # Global settings context
└── components/
    ├── ActionButton.test.tsx   # Action button component
    ├── EmptyState.test.tsx     # Empty state component
    ├── LoadingOverlay.test.tsx # Loading overlay component
    └── ModernSelect.test.tsx   # Select component
```

### Test Coverage by Category

#### Utility Tests (`utils/`)

| File | Tests | Description |
|------|-------|-------------|
| `formatting.test.ts` | 13 | `formatElapsed()` - elapsed time formatting (seconds, minutes, hours)<br>`getDisplayContent()` - content extraction with route plan markers |
| `helpers.test.ts` | 18 | `normalizeNameForKey()` - name normalization<br>`buildInternalKey()` - internal log key generation<br>`isMessageEntry()` - type guard<br>`findLastMessageEntry()` - log search<br>`countMessagesWithTurn()` - message counting |
| `parsing.test.ts` | 20 | `parsePositiveInt()` - positive integer parsing<br>`parseNumeric()` - number parsing<br>`toNumber()` - safe conversion with fallback<br>`clamp01()` - value clamping<br>`isActiveStatus()` - status check |
| `textProcessing.test.ts` | 19 | `collapseDuplicateSearchResults()` - search result deduplication<br>`removeResponseOutputTextBlocks()` - block removal<br>`normalizeInternalLogForDisplay()` - combined normalization |
| `meetingSync.test.ts` | 12 | `mergeMeetingData()` - type-safe meeting data merge |

#### Hook Tests (`hooks/`)

| File | Tests | Description |
|------|-------|-------------|
| `useChatState.test.ts` | 13 | Initial state, state updates, reset, voting selections |
| `useLocalStorage.test.ts` | 8 | Initialization, loading, updating, error handling |
| `useMeetingLogs.test.ts` | 21 | Message upsert, route plan updates, phase logs, internal events, timer management, localStorage cache |
| `useParticipants.test.ts` | 16 | Participant CRUD, API calls, modal state, drag & drop, error handling |

#### Component Tests (`components/`)

| File | Tests | Description |
|------|-------|-------------|
| `ActionButton.test.tsx` | 12 | Rendering, click events, disabled state, accessibility attributes, hover effects |
| `EmptyState.test.tsx` | 8 | Default/custom messages, icon rendering, styling |
| `LoadingOverlay.test.tsx` | 8 | Title/subtitle rendering, spinner animation, overlay styling |
| `ModernSelect.test.tsx` | 9 | Select rendering, disabled state, props forwarding, icon color changes |

#### Context Tests (`context/`)

| File | Tests | Description |
|------|-------|-------------|
| `MeetingContext.test.tsx` | 18 | Provider rendering, settings management, cache operations, convenience hooks |

### Test Setup (`setup.ts`)

The setup file provides global mocks:

```typescript
// localStorage mock with full API
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};

// fetch mock
global.fetch = vi.fn();

// Reset before each test
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});
```

### Writing New Tests

#### Utility Function Test Example

```typescript
import { describe, it, expect } from "vitest";
import { myFunction } from "../../utils/myModule";

describe("myFunction", () => {
  it("should handle normal input", () => {
    expect(myFunction("input")).toBe("expected");
  });

  it("should handle edge case", () => {
    expect(myFunction("")).toBe("");
  });
});
```

#### Hook Test Example

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMyHook } from "../../hooks/useMyHook";

describe("useMyHook", () => {
  it("should initialize with default values", () => {
    const { result } = renderHook(() => useMyHook());
    expect(result.current.value).toBe(0);
  });

  it("should update state", () => {
    const { result } = renderHook(() => useMyHook());
    act(() => {
      result.current.setValue(10);
    });
    expect(result.current.value).toBe(10);
  });
});
```

#### Component Test Example

```typescript
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MyComponent from "../../components/MyComponent";

describe("MyComponent", () => {
  it("should render correctly", () => {
    render(<MyComponent title="Test" />);
    expect(screen.getByText("Test")).toBeInTheDocument();
  });

  it("should handle click", () => {
    const onClick = vi.fn();
    render(<MyComponent onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });
});
```

### Test Configuration (`vitest.config.ts`)

```typescript
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,              // Enable global test functions
    environment: "jsdom",       // DOM environment for React
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "src/__tests__/setup.ts"],
    },
  },
});
```

### Test Statistics

| Category | Test Files | Tests | Status |
|----------|------------|-------|--------|
| Utils | 5 | 82 | ✅ |
| Hooks | 4 | 58 | ✅ |
| Components | 4 | 37 | ✅ |
| Context | 1 | 18 | ✅ |
| **Total** | **14** | **195** | ✅ |

---

## Type Definitions (types/index.ts)

Key types:

```typescript
// Meeting
interface MeetingInfo {
  id: string;
  title: string;
  created_at: string;
  participant_count: number;
  has_history: boolean;
  include_human?: boolean;
  status?: string;
  status_detail?: string | null;
  // ... various setting fields
}

// Log entry
type LogEntry = MessageOut | PhaseLogEntry;

interface MessageOut {
  kind: "message";
  name: string;
  content: string;
  turn: number;
  turnLabel?: string;
  routePlan?: RoutePlan;
  invitationHighlight?: string;
  internalLog?: string;
  // ...
}

interface PhaseLogEntry {
  kind: "phase";
  title: string;
  description?: string | null;
}

// WebSocket events
type WsEvent =
  | { type: "meeting_started"; goal: string; include_human?: boolean }
  | { type: "turn_start"; turn: number; speaker: string }
  | { type: "delta"; turn: number; speaker: string; delta: string; metadata?: DeltaMetadata }
  | { type: "turn_final"; turn: number; speaker: string; text: string; ... }
  | { type: "phase_message"; title: string; description?: string | null }
  | { type: "status"; meeting_id?: string; status?: string; reason?: string | null }
  | { type: "human_turn"; turn: number }
  | { type: "human_vote"; turn: number; vote_type: string; options: any }
  | { type: "meeting_finished"; turns: number }
  | { type: "error"; message: string }
  // ...
```

---

## Backend Tests

Backend (Python) tests are located in the project root `tests/` directory.

See [Backend Testing Documentation](../../tests/README.md) for details.
