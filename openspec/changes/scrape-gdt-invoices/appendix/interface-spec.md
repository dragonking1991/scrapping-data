# Interface Spec - Manual-first Collector Runtime

## Scope

Tai lieu nay chot pseudo-contract cho 3 module noi bo:
- collectorStateMachine
- checkpointStore
- events

Muc tieu: doi ngu implement cung bam mot chuan API noi bo, giam tranh cai trong luc code.

## 1) collectorStateMachine

### 1.1 Runtime states

- `idle`
- `manual_ready`
- `collecting`
- `session_expired`
- `resuming`
- `done`

### 1.2 Collecting phases (L2)

- `prepare`
- `list_fetch`
- `detail_fetch`
- `merge`
- `persist`
- `finalize`

### 1.3 Domain types (pseudo)

```ts
type UiRuntimeState = "idle" | "manual_ready" | "collecting" | "session_expired" | "resuming" | "done";
type CollectPhase = "prepare" | "list_fetch" | "detail_fetch" | "merge" | "persist" | "finalize";
type DoneStatus = "success" | "partial" | "failed";

interface CollectFilterContext {
  from: string;   // dd/mm/yyyy
  to: string;     // dd/mm/yyyy
  outputPath: string;
  invoiceType: "invoice" | "ticket";
}

interface SessionContext {
  sessionId: string;
  baseUrl: string;
}

interface ProgressCounters {
  pagesFetched: number;
  invoicesTotalPlanned: number;
  invoicesProcessed: number;
  invoicesSucceeded: number;
  invoicesFailed: number;
  retriesUsed: number;
}

interface CollectRuntimeContext {
  jobId: string;
  filter: CollectFilterContext;
  session: SessionContext;
  phase: CollectPhase;
  pageIndex: number;
  invoiceCursor: number;
  counters: ProgressCounters;
  startedAt: number;
  updatedAt: number;
}

interface CollectSummary {
  status: DoneStatus;
  durationMs: number;
  counters: ProgressCounters;
  outputPath?: string;
  warnings: string[];
  errors: string[];
}
```

### 1.4 Signals (input)

```ts
type RuntimeSignal =
  | { type: "APP_STARTED" }
  | { type: "MANUAL_READY_CONFIRMED"; session: SessionContext }
  | { type: "COLLECT_REQUESTED"; filter: CollectFilterContext }
  | { type: "SESSION_EXPIRED_DETECTED"; reason: string }
  | { type: "RELOGIN_CONFIRMED"; session: SessionContext }
  | { type: "CANCEL_REQUESTED" };
```

### 1.5 Ports

```ts
interface CollectorStateMachinePort {
  getState(): UiRuntimeState;
  getContext(): CollectRuntimeContext | null;
  dispatch(signal: RuntimeSignal): Promise<void>;
}

interface CollectorEnginePort {
  runPrepare(ctx: CollectRuntimeContext): Promise<CollectRuntimeContext>;
  runListFetchStep(ctx: CollectRuntimeContext): Promise<CollectRuntimeContext>;
  runDetailFetchStep(ctx: CollectRuntimeContext): Promise<CollectRuntimeContext>;
  runMerge(ctx: CollectRuntimeContext): Promise<CollectRuntimeContext>;
  runPersist(ctx: CollectRuntimeContext): Promise<CollectRuntimeContext>;
  runFinalize(ctx: CollectRuntimeContext): Promise<CollectSummary>;
  classifyAuthLoss(error: unknown): boolean;
}
```

### 1.6 State transition contract

- `idle -> manual_ready`: browser session san sang cho thao tac thu cong.
- `manual_ready -> collecting`: user bam Lay thong tin.
- `collecting -> session_expired`: auth lost (401/redirect login/403 het phien).
- `session_expired -> resuming`: user login lai va xac nhan.
- `resuming -> collecting`: resume plan hop le.
- `collecting -> done`: success/partial/failed.

## 2) checkpointStore

### 2.1 Checkpoint schema (pseudo)

```ts
type CheckpointPhase = "list_fetch" | "detail_fetch" | "merge" | "persist";

interface CheckpointAggregateDigest {
  invoiceNameMapVersion: number;
  invoiceProcessedIds: string[];
  invoiceFailedIds: string[];
}

interface CollectCheckpoint {
  jobId: string;
  phase: CheckpointPhase;
  pageIndex: number;
  invoiceCursor: number;
  filter: {
    from: string;
    to: string;
    outputPath: string;
    invoiceType: "invoice" | "ticket";
  };
  sessionHint: {
    baseUrl: string;
  };
  counters: {
    pagesFetched: number;
    invoicesTotalPlanned: number;
    invoicesProcessed: number;
    invoicesSucceeded: number;
    invoicesFailed: number;
    retriesUsed: number;
  };
  aggregateDigest: CheckpointAggregateDigest;
  outputTempPath?: string;
  updatedAt: number;
}

interface SaveCheckpointInput {
  checkpoint: CollectCheckpoint;
  reason: "phase_progress" | "session_expired" | "manual_pause" | "before_persist" | "after_persist";
}

interface ResumePlan {
  jobId: string;
  targetPhase: CheckpointPhase;
  checkpoint: CollectCheckpoint;
}
```

### 2.2 Store port

```ts
interface CheckpointStorePort {
  save(input: SaveCheckpointInput): Promise<void>;
  loadLatest(jobId: string): Promise<CollectCheckpoint | null>;
  planResume(jobId: string): Promise<ResumePlan | null>;
  clear(jobId: string): Promise<void>;
  listRecent(limit: number): Promise<CollectCheckpoint[]>;
}
```

### 2.3 Resume routing rule

- `targetPhase = list_fetch` neu chua vao detail.
- `targetPhase = detail_fetch` neu dang do invoice trong page.
- `targetPhase = merge` neu list/detail da xong.
- `targetPhase = persist` neu merge xong nhung chua flush output.

## 3) events

### 3.1 Event names

- `runtime.state.changed`
- `collect.phase.changed`
- `collect.progress.updated`
- `collect.session.expired`
- `collect.resume.requested`
- `collect.resume.accepted`
- `collect.done`
- `collect.error`

### 3.2 Event payload contracts (pseudo)

```ts
type RuntimeEvent =
  | {
      name: "runtime.state.changed";
      ts: number;
      payload: { prev: UiRuntimeState; next: UiRuntimeState; jobId?: string };
    }
  | {
      name: "collect.phase.changed";
      ts: number;
      payload: { jobId: string; phase: CollectPhase; pageIndex: number; invoiceCursor: number };
    }
  | {
      name: "collect.progress.updated";
      ts: number;
      payload: {
        jobId: string;
        pagesFetched: number;
        invoicesProcessed: number;
        invoicesSucceeded: number;
        invoicesFailed: number;
      };
    }
  | {
      name: "collect.session.expired";
      ts: number;
      payload: { jobId: string; phase: CollectPhase; checkpointId?: string; reason: string };
    }
  | {
      name: "collect.resume.accepted";
      ts: number;
      payload: { jobId: string; targetPhase: CheckpointPhase };
    }
  | {
      name: "collect.done";
      ts: number;
      payload: {
        jobId: string;
        status: DoneStatus;
        durationMs: number;
        outputPath?: string;
        warnings: string[];
        errors: string[];
      };
    };

interface EventPublisherPort {
  publish(event: RuntimeEvent): void;
}

interface EventSubscriberPort {
  subscribe(handler: (event: RuntimeEvent) => void): () => void;
}
```

## 4) Cross-module contract flow

1. UI gui `COLLECT_REQUESTED` vao state machine.
2. State machine chay engine theo phase va publish event.
3. Moi moc phase/progress quan trong deu save checkpoint.
4. Neu auth lost: state machine save checkpoint (`session_expired`) + publish `collect.session.expired` + chuyen `session_expired`.
5. User login lai, UI gui `RELOGIN_CONFIRMED`.
6. State machine goi `planResume`, publish `collect.resume.accepted`, tiep tuc o `targetPhase`.
7. Ket thuc, publish `collect.done`, clear checkpoint khi `success` (hoac giu lai theo policy neu `failed`).

## 5) Invariants (bat buoc)

- Khong mat tien do da xu ly khi resume.
- Khong commit trung invoice (idempotent theo key).
- Event UI phai nhat quan voi state runtime.
- 403 do thieu quyen co dinh khong duoc classify thanh auth expired de resume vo han.

## 6) Out of scope

- Dinh nghia chi tiet schema workbook merge implementation.
- Dinh nghia chi tiet permission model tu he thong GDT.
- Dinh nghia transport layer event (SSE/WebSocket) cu the; chi chot payload contract.
