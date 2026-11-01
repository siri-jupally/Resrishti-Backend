# Pickup Pipeline Revamp — Audit, Risks, Migration Strategy & Test Plan

**Status:** DRAFT for sign-off. No code changed yet. Branch: `feature/major-changes`.
**Scope:** 7-stage pickup workflow (all stages photo-gated), Pickup Closure (decoupled from certificates), certificate generation (monthly / date-range / single), decouple impact from certificate issuance.
**Audited against:** a full copy of **production data** restored into the test DB (cluster0) on 2026-11-01 (240 pickups).

---

## 1. Current implementation (as-is)

### 1.1 Pickup lifecycle (status enum — `models/Pickup.js:230-252`)
`requested → accepted → scheduled → en-route → at-client → picked-up → at-facility → weighed → processed → cert-draft → cert-issued → cert-sent`
plus `cancelled, rejected, postponed, failed, no-show`.

### 1.2 Agent "guided run" (phone only, `PickupRun.jsx`) — 7 screens, **3 photo stages**
| Step | Status transition | Photo? | Capture |
|---|---|---|---|
| 1 Head out | accepted/scheduled → en-route | no | GPS, time |
| 2 Empty truck | en-route → at-client | **yes** | empty-truck photo, GPS |
| 3 Fully loaded | at-client → picked-up | **yes** | loaded-truck photo, GPS |
| 4 At facility | picked-up → at-facility | no | GPS, time |
| 5 Weight slip | at-facility → weighed | **yes** | weighbridge-slip photo |
| 6 Enter weights | weighed → processed (WasteDataForm) | — | **per-stream kg entered manually** |
| 7 Done | processed/cert-* | — | — |

- Photo-required set (backend `supervisorPickupController.js` + `lib/pickupStatus.js`): **at-client, picked-up, weighed**.
- Transition transport: multipart `PATCH /api/{role}/my-pickups/:id/status` (field `photos`, lat/lng). Waste: `POST .../waste-data` (`lineItems` JSON + optional `weighbridgePhoto`).
- Desktop staff advance pickups via `MyPickupsTab` → `PickupActionPanel` (same endpoints, multi-photo). Admin triage via `AdminPickupDetail` (accept/reject/reschedule/correct-weights/cancel).

### 1.3 Weighing (today)
**Weighed once.** The weighbridge slip is photographed (stage 5), then the supervisor **manually types per-stream kg** in `WasteDataForm`. There is **no empty-vehicle / loaded-vehicle gross/tare/net capture** today — net total is just the sum of typed per-stream weights.

### 1.4 Certificates (`models/Certificate.js`, `certificateController.js`)
- **Exactly ONE type: Certificate of Disposal (CoD).** No `type` field exists. (All 207 prod certs show `type: null`.)
- **Strictly one certificate per pickup** (`pickup` ref required). No month/range concept.
- **Auto-drafted** inside `recordWasteData`: `weighed → processed → cert-draft` creates the draft cert automatically. There is **no manual "generate certificate" button** anywhere — generation is a side-effect of entering weights.
- Lifecycle: `draft → issued → sent`, plus `superseded` (revise) / `cancelled`. Driven manually by coordinators in `ManagerCertificatesTab` (issue/send/revise/cancel). Pickup mirrors it: cert-draft → cert-issued (on issue) → cert-sent (on send); cancel resets pickup to `processed`.
- `certNumber` = `CoD-YYYY-####` (atomic per-year counter). Client sees sent/superseded/cancelled; downloads sent/superseded (5-min presigned S3).

### 1.5 Monthly reports (`models/Report.js`, `reportController.js`)
- **Two types: Impact + GHG**, per **(client, month)**, generated **manually** by coordinators (`ManagerReportsTab`: pick client/month/year/type → preview → generate → issue → send → revise). No cron, no auto-on-cert.
- This is the **aggregation pattern** (one doc spanning many pickups over a period) that the certificate revamp wants — a ready template.

### 1.6 Impact calculations — the coupling map (the crux of requirement #5)
| Surface | Counts a pickup when… | Cert-gated? |
|---|---|---|
| **Monthly Impact/GHG reports** (`reportController`) | status ∈ {processed, cert-draft, cert-issued, cert-sent} **AND** has line items, month by `scheduledDate` | **NO** — already decoupled |
| **Client dashboard impact** (`clientPortalController.getDashboard`) | status ∈ {cert-issued, cert-sent} | **YES** |
| **Public marketing stats** (`statsJob.js` → StatsSnapshot) | status ∈ {cert-issued, cert-sent} | **YES** |
| **Management KPIs** (`managementDashboardController`) | keyed off cert status | **YES** |

➡️ The "impact linked to certificates" the spec wants removed lives in the **client dashboard + public stats + management KPIs**, **not** the monthly reports. Factors live in two unrelated files: `reportFactors.js` (reports) vs `wasteCategories.js`/`emissionFactors.js` (dashboards/public).

### 1.7 Real production data (on the test copy — what migration must protect)
240 pickups: **cert-draft 187**, cert-issued 18, accepted 15, at-client 7, at-facility 6, weighed 3, cert-sent 2, picked-up 1, postponed 1.
- 207 have waste data (`lineItems`) + a certificate ref; 240 have evidence; **0 use live tracking**.
- Certificates: draft 187, issued 18, sent 2 — all `type: null`.
- Reports: 6 Impact (no GHG generated in prod).
- **Genuinely in-field / mid-pipeline:** ~33 (accepted/at-client/at-facility/weighed/picked-up/postponed). **The other ~207 are "waste recorded, cert in some state."**

---

## 2. Target (revamp) — deltas from current

1. **New 7-stage workflow, EVERY stage photo-gated** (vs 3 today): (1) vehicle started → (2) empty vehicle on weighbridge **[empty weight]** → (3) empty vehicle at client → (4) loading started → (5) fully loaded at client → (6) fully loaded on weighbridge **[loaded weight → net]** → (7) reached facility.
2. **Twice-weighed model** (empty + loaded vehicle → net) replaces today's single manual per-stream entry. **← biggest functional change; see Risk R2 / Decision Q2.**
3. **Pickup Closure stage** replaces `cert-draft`: review details → show/edit per-stream weights → recalc → confirm → **Closed**. Closing is independent of certificates.
4. **Certificate generation = 3 methods:** monthly (client+month), custom date-range, single-pickup. "All three existing certificate types." **← only 1 cert type exists today; see Decision Q1.**
5. **Optional cert at closure** ("Does this pickup need a certificate? Yes/No"); cert failure must never block closure.
6. **Decouple impact from cert issuance:** closed pickup counts in impact immediately (client dashboard + public stats re-pointed off cert status).

---

## 3. Risks (ranked)

- **R1 — "Three certificate types" mismatch (BLOCKER).** Only CoD exists; the two "report types" (Impact, GHG) are a different model. Must resolve before designing cert generation. → **Q1**.
- **R2 — Weighing model change (HIGH).** New stages 2 & 6 capture *vehicle* empty/loaded weights (net = loaded − empty). Today weights are *per waste stream*, typed manually. How net vehicle weight reconciles with the per-stream breakdown (which certs & reports need) is undefined. → **Q2**.
- **R3 — Impact decoupling moves live numbers (HIGH, intended).** Re-pointing client dashboard + public stats from cert-gated (~20 pickups) to "closed" (~207) will **visibly jump** the client's and public impact figures. Monthly reports won't change (already count these). Must be confirmed as intended + scoped. → **Q3**.
- **R4 — 187 `cert-draft` pickups (the removed step).** Must map to the new "Closed" state, keep their certificates, stay report-eligible, and (post-decoupling) become dashboard-eligible — without appearing to "regenerate" or alter history. → **Q5 (default proposed)**.
- **R5 — ~33 in-flight pickups can't map cleanly** old 3-photo → new 7-photo stages (e.g. old "at-client" never captured "empty vehicle on weighbridge"). Forcing a mapping would skip now-required photos or demand re-work. → **Q4**.
- **R6 — Status-enum ripple.** New statuses touch `lib/pickupStatus.js` (8+ maps), `SUPERVISOR_NEXT`, timeline orders, both backend controllers, client-side masking — must change in lockstep or timelines/badges/transitions break.
- **R7 — Monthly/range certificate aggregation is new.** Certs are per-pickup today; monthly/range implies either a new aggregate-cert model or bulk per-pickup issuance. Needs a data-model decision + **dedupe** so a pickup isn't certified twice across overlapping ranges/months/single. → **Q6**.
- **R8 — Concurrency & failure safety.** Duplicate closure, concurrent weight edits, failed/duplicate photo uploads, network drops (spec §7). Needs idempotent closure + optimistic locking on weight edits.
- **R9 — Deploy = prod.** Backend `main` auto-deploys. All of this ships only after passing tests on the prod-copy test DB, then a deliberate merge to `main`.

---

## 4. Proposed migration strategy (safe, additive)

**Principle: additive, never overwrite existing status values (per spec §6). Old and new coexist, keyed by a version tag.**

1. **Add `pipelineVersion` to `Pickup`** (default `1` for all existing rows via idempotent backfill; new pickups = `2`). No existing status value is renamed or rewritten.
2. **Add the new v2 statuses additively** to the enum (e.g. `stage1-departed … stage7-at-facility`, `closed`) alongside the legacy ones. The legacy enum values stay valid forever.
3. **Legacy completed/near-complete (processed, cert-draft, cert-issued, cert-sent — ~207):** treated as **Closed-equivalent** by a mapping layer (no data rewrite; a read-time map + a `closedAt`/`isClosed` derived flag). They keep their certificates and remain report-eligible. (Decision Q5: do we *also* set them dashboard-eligible → the R3 jump.)
4. **In-flight v1 pickups (~33):** **grandfather** — they finish under the v1 flow (the old STEP map stays available for `pipelineVersion:1`). New pickups use v2. No resets, no forced re-photographing. (Decision Q4: grandfather vs a controlled "adopt v2" transition.)
5. **Evidence preserved untouched** — the `evidence[]` array is append-only and stage-keyed already; new stages just add new `status` keys. Old photos keep rendering.
6. **Certificates & reports untouched structurally** for existing rows; new cert-generation methods are additive endpoints.
7. **Migrations:** idempotent scripts (safe to re-run), run first against the **test copy**, wrapped so they can be re-applied; no destructive field drops/renames; rollback = the version tag + additive-only changes mean v1 behaviour is always intact.

**Why grandfather in-flight rather than remap:** the old→new stage mapping is lossy (3 photo points vs 7, no empty-vehicle weighbridge capture historically). The spec itself says *"if a direct mapping is not possible, retain the original progress and introduce a controlled transition rather than forcing an incorrect mapping."* With only ~33 in-flight, grandfathering is the lowest-risk reading of that.

---

## 5. Test plan (against the prod copy + synthetic v2 pickups)

All tests run on the **cluster0 test DB (prod copy)** before any deploy. Combine automated (Jest + a data-driven harness over the copy) with manual UI walkthroughs.

**Backward-compat (existing data) — must stay green:**
| Scenario | Expectation |
|---|---|
| A completed (cert-sent) pickup | unchanged, cert downloadable |
| One of the 187 cert-draft pickups | shows as Closed-equiv, cert intact, still in its month's report |
| cert-issued pickup | cert still issued/downloadable, not reverted |
| In-field pickup (at-client / at-facility / weighed) | continues on v1 flow, no reset, evidence intact, not forced to add new-stage photos |
| Pickup with only old-era photos | no forced re-upload; timeline renders old evidence |
| Existing 6 Impact reports | regenerate/preview to identical totals (no drift) |

**New workflow (v2):**
| Scenario | Expectation |
|---|---|
| New pickup, all 7 stages | each stage blocks until its photo is captured; net weight = loaded − empty |
| Close without certificate | status Closed; counts in monthly calc + (per Q3) dashboards; cert generatable later |
| Edit stream weights at closure | totals + impact recompute; audit-trail entry written |
| Individual cert at closure (Yes) | preview → issue; **cert failure still leaves pickup Closed** |
| Monthly cert (client+month) | aggregates all eligible closed pickups once |
| Custom date-range cert | only eligible pickups in range; **no double-count** vs monthly/single |
| Single pickup already in a monthly cert | dedupe prevents re-certifying |
| Multiple pickups in a month | correct aggregation, no duplication |
| Month-boundary (scheduledDate) | pickup lands in exactly one period |

**Resilience:** duplicate closure requests (idempotent), concurrent weight edits (optimistic lock), failed/duplicate photo upload (all-or-nothing), invalid stage transition (409), missing/invalid weighbridge value, historical cert download.

---

## 6. Decisions (LOCKED 2026-11-01)

- **Q1 — three "types" = CoD + Impact + GHG.** No new document types. Extend the existing CoD certificate and the two reports with the new generation methods.
- **Q2 — weighing = per-stream manual entry stays the source of truth.** Stages 2 & 6 capture empty/loaded **vehicle** weights as **evidence + a cross-check** only; they do **not** derive per-stream quantities. (Net vehicle weight may be shown at closure as a reconciliation figure.)
- **Q3 — decouple BOTH client dashboard AND public stats** → count **closed** pickups everywhere. Accepted consequence: the client + public live impact numbers jump from ~20 to ~207 pickups. Monthly reports unchanged (already counted these).
- **Q4 — grandfather the ~33 in-flight pickups** on the v1 flow. Only new pickups use v2.

### Defaults I'll proceed on (raise now if any is wrong)
- **Q5 — the 187 cert-draft (+18 cert-issued +2 cert-sent):** treated as **Closed-equivalent** — keep their certificates, keep their monthly-report counts, and (per Q3) they become dashboard/public-impact eligible. No cert regeneration, no history rewrite.
- **Q6 — certificate coverage:** a CoD may cover **one pickup (single)** or **many pickups (monthly/date-range aggregate)**. Add `coverage` + `pickupIds[]` to the cert model (additive); **dedupe guard: a pickup may belong to at most one active (non-cancelled) CoD.** Impact + GHG reports keep their existing per-(client,month) model and gain date-range + single-pickup variants.
- **Q7 — permissions/audit:** **close** a pickup = the assigned supervisor (field) or a coordinator/admin; **correct a closed** pickup's weights = coordinator/admin only, each correction appended to `wasteDataHistory` with actor + reason (audit trail already exists there).

## 7. Phased implementation plan (each phase validated on the prod copy before the next)

- **Phase 0 — Migration scaffolding & safety net.** Add `pipelineVersion` (backfill existing → v1, idempotent); additive v2 status values + Closed-equivalent mapping layer; lock existing-data regression tests (the §5 backward-compat table) green. No behaviour change for v1.
- **Phase 1 — New 7-stage v2 agent workflow.** New STEP map (all 7 photo-gated), empty/loaded vehicle-weight capture (cross-check evidence), v2 state machine + photo gating (backend + `lib/pickupStatus` maps + run UI + desktop panel + timeline). v1 grandfathered.
- **Phase 2 — Pickup Closure (decoupled from certs).** Closure flow (review → edit per-stream weights → recalc → confirm → Closed); split `recordWasteData` so closing no longer auto-drafts a cert; idempotent closure + optimistic-lock on weight edits; audit trail.
- **Phase 3 — Decouple impact.** Re-point client dashboard + public `statsJob` + management KPIs to count **closed** pickups; verify monthly reports unchanged.
- **Phase 4 — Certificate generation (3 methods).** On-demand single-pickup CoD; aggregate monthly/date-range CoD (coverage model + dedupe); date-range + single variants for Impact/GHG; optional cert at closure with preview; cert failure never blocks closure.
- **Phase 5 — Full test pass on the prod copy + UI polish**, then a deliberate merge to `main` (= deploy).

> Implementation proceeds on `feature/major-changes`; nothing deploys until Phase 5 passes and you approve the merge.
