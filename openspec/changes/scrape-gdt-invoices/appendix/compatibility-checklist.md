# Compatibility Checklist - File-by-file Adapter Plan

## Purpose

Tai lieu nay la checklist tuong thich de chuyen code hien tai sang contract runtime moi da chot trong:
- [interface-spec.md](interface-spec.md)

Nguyen tac:
- Khong rewrite all-at-once.
- Tao adapter layer truoc, doi hanh vi sau.
- Moi file cu phai co owner va trang thai migration ro rang.

## Migration Status Legend

- `[ ]` Chua bat dau
- `[~]` Dang migration
- `[x]` Da dat contract moi
- `[!]` Co risk/chua chot decision

## A. Core runtime contracts

### 1) src/runtime/collectorStateMachine.ts (file moi)

- Status: `[ ]`
- Contract target: `CollectorStateMachinePort`, `RuntimeSignal`, `UiRuntimeState`, `CollectRuntimeContext`
- Adapter steps:
  - [ ] Tao state machine L1 (`idle/manual_ready/collecting/session_expired/resuming/done`).
  - [ ] Tich hop L2 phase (`prepare/list_fetch/detail_fetch/merge/persist/finalize`) vao context.
  - [ ] Implement `dispatch(signal)` bat buoc async, idempotent cho signal lap lai.
  - [ ] Inject `CollectorEnginePort`, `CheckpointStorePort`, `EventPublisherPort`.
  - [ ] Dam bao `SESSION_EXPIRED_DETECTED` khong lam mat progress.
- Done when:
  - [ ] State transitions khop 100% voi interface spec.
  - [ ] Co test cho happy path + session expired + resume.

### 2) src/runtime/checkpointStore.ts (file moi)

- Status: `[ ]`
- Contract target: `CheckpointStorePort`, `CollectCheckpoint`, `ResumePlan`
- Adapter steps:
  - [ ] Chon backend luu checkpoint (json file local) va naming theo `jobId`.
  - [ ] Implement `save/loadLatest/planResume/clear/listRecent`.
  - [ ] Validate schema toi thieu (`phase/pageIndex/invoiceCursor/counters/updatedAt`).
  - [ ] Co co che write-atomic (ghi file tam -> rename).
- Done when:
  - [ ] Resume khong quay lai tu dau neu dang o `detail_fetch` hoac `merge`.
  - [ ] Loi file checkpoint khong lam crash toan bo process.

### 3) src/runtime/events.ts (file moi)

- Status: `[ ]`
- Contract target: `RuntimeEvent`, `EventPublisherPort`, `EventSubscriberPort`
- Adapter steps:
  - [ ] Tao event bus noi bo typed payload.
  - [ ] Support subscribe/unsubscribe an toan.
  - [ ] Chuan hoa emit cac event: state/phase/progress/session_expired/resume/done/error.
- Done when:
  - [ ] UI SSE co the map 1-1 tu runtime event sang payload frontend.

## B. Existing files and required adapters

### 4) src/cli.ts

- Status: `[ ]`
- Current role: orchestration full pipeline + endpoint fallback
- Required adapter:
  - [ ] Tach orchestration truc tiep thanh signal-driven runtime call.
  - [ ] Thay login/list/detail/merge sequence bang `dispatch(APP_STARTED -> MANUAL_READY_CONFIRMED -> COLLECT_REQUESTED)`.
  - [ ] Khi `--relogin`, phat `RELOGIN_CONFIRMED` thay vi tu chay lai toan bo.
  - [ ] Bao toan fallback logic `third-party -> standard` nhung dua vao `CollectorEnginePort`.
- Contract checks:
  - [ ] Khong giu business state trong CLI; state thuoc `CollectRuntimeContext`.

### 5) src/ui/server.ts

- Status: `[ ]`
- Current role: Tailwind UI + spawn CLI + SSE events co ban
- Required adapter:
  - [ ] Map nut `Lay thong tin` -> `COLLECT_REQUESTED`.
  - [ ] Map nut `Re-login ngay roi chay` -> `RELOGIN_CONFIRMED`.
  - [ ] Render runtime state theo `runtime.state.changed` thay vi doc stdout text.
  - [ ] Hien thi phase/progress theo `collect.phase.changed` + `collect.progress.updated`.
  - [ ] Hien thi banner khi `collect.session.expired` va cho user thao tac login lai.
- Contract checks:
  - [ ] UI khong tu suy luan state; chi dua tren event contract.

### 6) src/auth/login.ts

- Status: `[ ]`
- Current role: login/captcha/token extraction/manual wait token
- Required adapter:
  - [ ] Chuyen thanh AuthSessionService phuc vu manual-first (xac nhan session hop le).
  - [ ] Bo assumptions "CLI always owns login"; ho tro mode chi verify token/cookie hien co.
  - [ ] Phat hien het phien thong nhat voi `classifyAuthLoss`.
- Contract checks:
  - [ ] Khong block terminal captcha path trong manual-first mode.

### 7) src/auth/tokenCache.ts

- Status: `[ ]`
- Current role: luu/reuse bearer token
- Required adapter:
  - [ ] Them metadata phuc vu resume (`sessionId/baseUrl/updatedAt`).
  - [ ] Cung cap ham clear selective theo profile.
  - [ ] Dam bao cache stale khong override session moi sau relogin.
- Contract checks:
  - [ ] Token cache chi la optimization, khong la source of truth cua runtime state.

### 8) src/api/client.ts

- Status: `[ ]`
- Current role: axios wrapper + retry + enriched error
- Required adapter:
  - [ ] Chuan hoa classifier cho auth-loss vs permission-denied:
    - 401/redirect-login => auth loss.
    - 403 thieu quyen co dinh => permission error, khong auto-resume vo han.
  - [ ] Tra ve error code machine-readable cho state machine.
- Contract checks:
  - [ ] Bao toan thong diep `METHOD URL -> status; body=...` de debug.

### 9) src/api/invoices.ts

- Status: `[ ]`
- Current role: list/detail + shape compatibility
- Required adapter:
  - [ ] Tach function theo phase de hop voi engine:
    - `fetchListPage` (list_fetch)
    - `fetchInvoiceDetail` (detail_fetch)
  - [ ] Support resume cursor (`pageIndex/invoiceCursor`).
  - [ ] Return typed result gom counters delta de runtime cap nhat.
- Contract checks:
  - [ ] Idempotent voi invoice da xu ly (dua vao digest/id set).

### 10) src/export/download.ts

- Status: `[ ]`
- Current role: export xlsx theo profile
- Required adapter:
  - [ ] Dua vao phase `persist` hoac `finalize` ro rang.
  - [ ] Neu export that bai tam thoi, co retry theo policy engine.
  - [ ] Emit metadata nguon du lieu (`api/dom/fallback`) vao context cho merge.
- Contract checks:
  - [ ] Khong ghi de output cuoi truoc khi state machine vao phase `persist`.

### 11) src/export/merge.ts

- Status: `[ ]`
- Current role: merge ten hang hoa vao workbook
- Required adapter:
  - [ ] Nhan `aggregateDigest` + metadata columns theo D12.
  - [ ] Ho tro merge tiep tuc khi resume (khong ghi trung dong da merge).
  - [ ] Tra summary phu hop `CollectSummary` (`warnings/errors/counters`).
- Contract checks:
  - [ ] Idempotent khi chay lai voi cung checkpoint.

### 12) src/shared/config.ts

- Status: `[ ]`
- Current role: env parse + profile endpoints
- Required adapter:
  - [ ] Bo sung config checkpoint (`GDT_CHECKPOINT_PATH`, retention).
  - [ ] Bo sung timeout/chinh sach resume (`GDT_RESUME_ON_RELOGIN=true/false`).
  - [ ] Validate cheo mode manual-first voi profile endpoints.
- Contract checks:
  - [ ] Config loi phai fail-fast truoc khi vao runtime.

### 13) src/verify.ts

- Status: `[ ]`
- Current role: endpoint diagnostics
- Required adapter:
  - [ ] Them verify cho contract moi:
    - auth-loss classifier.
    - checkpoint read/write health.
    - event stream sanity (co emit phase + progress).
- Contract checks:
  - [ ] Verify output phan biet ro "permission issue" vs "session expired".

## C. Suggested implementation sequence

1. [ ] Tao module moi: `runtime/events.ts`, `runtime/checkpointStore.ts`, `runtime/collectorStateMachine.ts`.
2. [ ] Adapter `api/client.ts` + `api/invoices.ts` thanh `CollectorEnginePort`.
3. [ ] Adapter `export/download.ts` + `export/merge.ts` vao phase `persist/finalize`.
4. [ ] Adapter `auth/login.ts` + `auth/tokenCache.ts` cho manual-first/relogin.
5. [ ] Adapter `ui/server.ts` sang event-driven rendering.
6. [ ] Rut gon `cli.ts` con signal dispatcher + bootstrap wiring.
7. [ ] Nang cap `verify.ts` va them test matrix resume.

## D. Test matrix checklist (minimum)

- [ ] Happy path: manual login -> collect -> done(success).
- [ ] Session expire o `list_fetch` -> relogin -> resume.
- [ ] Session expire o `detail_fetch` giua page -> resume dung `invoiceCursor`.
- [ ] Session expire o `merge/persist` -> resume khong tao duplicate output.
- [ ] 403 fixed-permission -> ket thuc failed/partial, khong loop relogin.
- [ ] Restart process giua chung -> load checkpoint -> resume thanh cong.

## E. Ownership & handoff

- [ ] Gan owner cho tung file adapter.
- [ ] Moi PR migration phai attach phan checklist lien quan.
- [ ] Khong tick `[x]` neu chua co bang chung test/verify cho muc do do.
