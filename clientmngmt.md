# Client Management & Operations Module

> **Status:** Draft spec for Phase 1 implementation
> **Owner:** Resrishti Engineering
> **Last updated:** 2026-05-10
> **Scope:** This file is the single source of truth for the Client Management module — covering business flow, data model, API surface, state machines, Phase 1 implementation guide, deferred Phase 2/3 items, open decisions, and edge cases.

---

## Table of Contents

1. [Why This Module](#1-why-this-module)
2. [End-to-End Flow](#2-end-to-end-flow)
3. [Confirmed Decisions](#3-confirmed-decisions)
4. [Roles, the "Supervisor" Job, and Permissions](#4-roles-the-supervisor-job-and-permissions)
5. [Phase 1 Scope (What We Build Now)](#5-phase-1-scope-what-we-build-now)
6. [Data Model (Mongoose)](#6-data-model-mongoose)
7. [API Surface](#7-api-surface)
8. [State Machines](#8-state-machines)
9. [Frontend Surface (Screens)](#9-frontend-surface-screens)
10. [Magic-Link Onboarding & Client Portal Auth](#10-magic-link-onboarding--client-portal-auth)
11. [Certificate Generation](#11-certificate-generation)
12. [Public Site Live-Stats Integration](#12-public-site-live-stats-integration)
13. [Notification Plan](#13-notification-plan)
14. [Phase 1 Implementation Guide (Step-by-Step)](#14-phase-1-implementation-guide-step-by-step)
15. [Phase 2 — WhatsApp, Recurring, Compliance Cert Templates](#15-phase-2--whatsapp-recurring-compliance-cert-templates)
16. [Phase 3 — Multi-Contact, Multi-Branch, Invoicing, Portal Maturity](#16-phase-3--multi-contact-multi-branch-invoicing-portal-maturity)
17. [Open Questions (Needs Decision)](#17-open-questions-needs-decision)
18. [Edge Cases & Validations](#18-edge-cases--validations)
19. [Compliance Notes (TGPCB / CPCB)](#19-compliance-notes-tgpcb--cpcb)
20. [Integration Points with Existing Modules](#20-integration-points-with-existing-modules)
21. [Success Criteria & Metrics](#21-success-criteria--metrics)
22. [Risks & Mitigations](#22-risks--mitigations)

---

## 1. Why This Module

Resrishti's app today handles the **operations side** (employees, managers, attendance, tasks). The entire **client side** — leads, onboarding, pickup orders, certificates, billing — lives in spreadsheets, email threads, and WhatsApp messages.

This module brings the **client lifecycle into the platform**, end-to-end:

| Pain today | What this module replaces it with |
|---|---|
| Client list scattered across spreadsheets per manager | Single Client table with org-wide visibility |
| Pickup requests by phone/WhatsApp, no SLA tracking | Structured pickup pipeline with state, timestamps, evidence |
| CoDs hand-typed in Word, signed-and-scanned | Auto-generated PDF from recorded weights, reviewable + sendable |
| Client has no way to see history or status | Branded client portal: live status, pickup history, downloads |
| Marketing-site impact numbers are hard-coded | Live stats fed from actual pickup data |

---

## 2. End-to-End Flow

```
1. Admin creates Client (basic details: company name, contact, email, phone, address)
        ↓
2. App generates magic-link onboarding token, emails to client contact
        ↓
3. Client opens link → completes onboarding (set password, optional KYC details)
        ↓
4. Client logs in to /client portal:
       - Sees impact stats (kg recycled by stream, CO₂e avoided, certs received)
       - Views pickup history
       - Clicks "Request Pickup"
        ↓
5. Client submits pickup request (date, expected streams, notes)
        ↓
6. Notification fires to Resrishti Admin + Coordinator(s)
        ↓
7. Coordinator/Admin reviews request → Accepts (or Rejects with reason)
        ↓
8. Coordinator assigns a Supervisor (any user tagged as supervisor-capable)
       - Sets scheduled pickup date/time
        ↓
9. Client portal updates → shows: "Pickup scheduled. Supervisor: <name>, <phone>"
   (Phase 2: WhatsApp confirmation sent to client)
        ↓
10. Supervisor's dashboard shows the assigned pickup
        ↓
11. Supervisor advances pickup through statuses (each with photo + GPS evidence):
       Scheduled → En-route → At-Client → Picked-up → At-Facility → Weighed → Processed
        ↓
12. After "Processed", Resrishti user is prompted to fill waste-data form:
       - kg of each stream (plastic / paper / e-waste / biomedical / etc.)
       - Optional: batch / lot / weighbridge slip photo
        ↓
13. Certificate auto-generated as Draft using recorded data
        ↓
14. Manager/Admin reviews Draft → clicks "Issue" → cert becomes immutable
        ↓
15. Manager/Admin clicks "Send Certificate" → cert sent to client (email + portal notification)
        ↓
16. Client portal: cert visible in "My Certificates" tab, downloadable as PDF
        ↓
17. All weighed quantities flow into:
       - Client's portal stats dashboard
       - Org-wide stats (admin dashboard)
       - Public website live-stats counters (cached, 15-min refresh)
```

---

## 3. Confirmed Decisions

These were settled in the design discussion on 2026-05-10:

| # | Question | Decision |
|---|---|---|
| **D1** | Is "Supervisor" a new role? | **No.** Supervisor is a **job/tag** that can be added to any existing role (Employee, Manager, or Admin). Anyone tagged as supervisor-capable can be assigned to a pickup. See §4. |
| **D2** | WhatsApp in Phase 1? | **No — deferred to Phase 2.** Phase 1 uses email + in-app notifications only. WhatsApp template-approval delays + provider selection are isolated to P2. |
| **D3** | Multi-contact / multi-branch per client in Phase 1? | **No — one client = one contact in P1.** Phase 3 adds multi-contact + multi-branch support. |

---

## 4. Roles, the "Supervisor" Job, and Permissions

### Roles (existing, unchanged)

```
Admin → Manager → Employee
```

### Supervisor — a JOB, not a role

- Stored as a Boolean flag `canSupervise: true|false` on the existing Employee, Manager, Admin models.
- Any user with `canSupervise: true` appears in the **"Assign Supervisor"** dropdown when accepting a pickup request.
- The flag is toggled by the Admin from each user's profile.
- A pickup stores the supervisor as a polymorphic ref + denormalized snapshot:
  ```js
  pickup.supervisor = {
      userType: 'Employee' | 'Manager' | 'Admin',
      userId: ObjectId,
      name: string,    // snapshot at assignment time
      phone: string,   // snapshot — historical pickups keep the phone shown to client
      assignedAt: Date,
      assignedBy: ObjectId,
  }
  ```

### Coordinator — also a JOB tag

To avoid noisy notifications when a client requests a pickup, only users with the **`canCoordinate: true`** flag receive the new-request notification. Coordinators triage requests: accept / reject / assign supervisor.

> If you'd rather collapse Coordinator into Admin (i.e., only Admins triage), drop `canCoordinate` and replace it with role checks. Recommended to keep it as a tag so Managers can also act as Coordinators when needed.

### Permission matrix (Phase 1)

| Action | Admin | Manager (with `canCoordinate`) | Manager (without) | Employee |
|---|---|---|---|---|
| Create Client | ✅ | — | — | — |
| List all Clients | ✅ | ✅ (own portfolio) | — | — |
| Receive new-pickup-request notification | ✅ | ✅ (with `canCoordinate`) | — | — |
| Accept / Reject pickup request | ✅ | ✅ (with `canCoordinate`) | — | — |
| Assign Supervisor | ✅ | ✅ (with `canCoordinate`) | — | — |
| Update pickup status (assigned to me as supervisor) | ✅ | ✅ | ✅ | ✅ |
| Enter waste data | ✅ | ✅ | ✅ (with `canSupervise`) | ✅ (with `canSupervise`) |
| Review + Issue Certificate | ✅ | ✅ | — | — |
| Send Certificate to client | ✅ | ✅ | — | — |
| Re-issue (revise) Certificate | ✅ | — | — | — |
| Delete Client | ✅ | — | — | — |

### "Supervisor-capable" pool query

```js
// Backend helper used by the Assign-Supervisor dropdown
const supervisorCandidates = await Promise.all([
    Admin.find({ canSupervise: true }).select('_id name phone email').lean(),
    Manager.find({ canSupervise: true }).select('_id name phone email').lean(),
    Employee.find({ canSupervise: true }).select('_id name phone email').lean(),
]);
// Tag each with userType, flatten, sort by name
```

---

## 5. Phase 1 Scope (What We Build Now)

The minimum viable end-to-end client → pickup → cert flow.

### In Scope (Phase 1)

| # | Feature | Notes |
|---|---|---|
| 1 | **Client model + admin CRUD** | One client = one contact (no multi-branch, no multi-user) |
| 2 | **Magic-link onboarding** | Email-only. Token in URL, 7-day expiry, single-use. |
| 3 | **Client portal** with login | New `/client/*` routes, separate JWT subject |
| 4 | **Client portal — Dashboard tab** | Live stats: kg diverted, certs received, last pickup date |
| 5 | **Client portal — Pickup history tab** | All pickups with status timeline |
| 6 | **Client portal — Request pickup** | Ad-hoc only (no recurring contracts in P1) |
| 7 | **Client portal — Certificates tab** | View + download PDFs |
| 8 | **Internal pickup pipeline** | Admin + Coordinator views: requests queue, in-progress pickups, accept/reject/assign |
| 9 | **Supervisor flow** | "My pickups" on existing Employee/Manager dashboard. Status update buttons + photo evidence at each stage. |
| 10 | **Waste-data entry form** | After "Processed" status, prompt to enter kg per stream + optional weighbridge photo |
| 11 | **Cert auto-generation (Draft)** | Single branded Resrishti template (NOT stream-specific compliance forms yet) |
| 12 | **Manager review + Issue + Send** | Three-step flow with audit trail |
| 13 | **Public-site `/impact` page** | Migrated from hard-coded numbers to live-stats API (15-min cache) |
| 14 | **Notifications** | Push + in-app + email (no WhatsApp). Triggers: new request, request accepted, supervisor assigned, pickup status changes, cert sent. |
| 15 | **`canSupervise` + `canCoordinate` flags** | Admin can toggle on each user's profile |

### Out of Scope for Phase 1 (deferred)

| Feature | Phase |
|---|---|
| WhatsApp notifications | 2 |
| Recurring pickup contracts | 2 |
| Stream-specific compliance cert templates (Form 4 for biomedical, etc.) | 2 |
| Multi-contact per client | 3 |
| Multi-branch per client | 3 |
| Invoicing + billing + Razorpay | 3 |
| Pickup-request approval workflow inside client's org | 3 |
| Two-person sign-off for large waste loads | 3 |
| 2-way WhatsApp conversation | 3 |
| Driver / vehicle management | 3 |
| Route optimization | 3 |
| Client-side analytics export (CSV, PDF) | 3 |
| AI / ML lead scoring / churn prediction | future |

---

## 6. Data Model (Mongoose)

All new models live under `Resrishti-Backend/models/`. Existing models gain a few fields.

### 6.1 New: `Client.js`

```js
const clientSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        // Phase 1: one contact only. Keep it inline; promote to a `Contact` sub-array in Phase 3.
        contactName: { type: String, required: true, trim: true },
        contactEmail: {
            type: String,
            required: true,
            unique: true,         // Phase 1 — one client per email
            lowercase: true,
            trim: true,
        },
        contactPhone: { type: String, required: true, trim: true },
        billingAddress: {
            line1: String, line2: String, city: String, state: String,
            postalCode: String, country: { type: String, default: 'India' },
        },
        gstin: { type: String, trim: true },
        industry: {
            type: String,
            enum: ['Hospital', 'FMCG', 'IT', 'Industrial', 'Hospitality',
                   'Education', 'Government', 'Retail', 'Other'],
        },
        // Auth — set after onboarding completed
        passwordHash: { type: String, select: false },
        isOnboardingComplete: { type: Boolean, default: false },
        // Owner inside Resrishti (account manager). Optional in P1.
        accountManager: { type: mongoose.Schema.Types.ObjectId, ref: 'Manager' },
        status: {
            type: String,
            enum: ['active', 'paused', 'churned', 'pending-onboarding'],
            default: 'pending-onboarding',
        },
        tags: [String],
        // Push subscription (same pattern as Employee/Manager/Admin)
        pushSubscription: { type: Object },
    },
    { timestamps: true }
);

// Same trim-on-hash/compare pattern as Employee — see commit 671f3af
clientSchema.pre('save', async function () {
    if (!this.isModified('passwordHash')) return;
    const cleaned = String(this.passwordHash ?? '').trim();
    if (!cleaned) throw new Error('Password cannot be empty');
    const bcrypt = require('bcryptjs');
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(cleaned, salt);
});

clientSchema.methods.comparePassword = async function (candidate) {
    if (!this.passwordHash) return false;
    const bcrypt = require('bcryptjs');
    const cleaned = String(candidate ?? '').trim();
    if (!cleaned) return false;
    return bcrypt.compare(cleaned, this.passwordHash);
};

clientSchema.index({ contactEmail: 1 }, { unique: true });
clientSchema.index({ status: 1 });
```

### 6.2 New: `OnboardingToken.js`

```js
const onboardingTokenSchema = new mongoose.Schema(
    {
        client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
        token: { type: String, required: true, unique: true }, // 32+ chars cryptographically random
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    },
    { timestamps: true }
);

// Auto-delete expired tokens 7 days after expiry to keep collection clean
onboardingTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });
onboardingTokenSchema.index({ token: 1 }, { unique: true });
```

### 6.3 New: `Pickup.js`

```js
const wasteLineItemSchema = new mongoose.Schema({
    stream: {
        type: String,
        required: true,
        enum: ['plastic', 'paper', 'ewaste', 'biomedical', 'foam-thermocol',
               'dry-waste', 'agr', 'battery', 'expired-food', 'hazardous', 'other'],
    },
    qtyKg: { type: Number, required: true, min: 0 },
    weighbridgePhoto: { key: String, bucket: String, _id: false },
    notes: String,
}, { _id: false });

const evidenceSchema = new mongoose.Schema({
    status: String,        // which status this evidence is for
    photo: { key: String, bucket: String, _id: false },
    gps: { lat: Number, lng: Number, _id: false },
    at: { type: Date, default: Date.now },
    by: {
        userType: { type: String, enum: ['Admin', 'Manager', 'Employee'] },
        userId: mongoose.Schema.Types.ObjectId,
        name: String,
    },
}, { _id: false });

const pickupSchema = new mongoose.Schema(
    {
        pickupID: { type: String, required: true, unique: true }, // e.g. PU-20260510-A7F2
        client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
        // Snapshot client name + address so historical records are stable
        clientNameSnapshot: String,
        pickupAddressSnapshot: String,

        // Request details
        requestedAt: { type: Date, default: Date.now },
        requestedDate: { type: Date }, // when client wants the pickup
        requestedStreams: [String],
        clientNotes: String,

        // Triage
        status: {
            type: String,
            required: true,
            default: 'requested',
            enum: ['requested', 'accepted', 'rejected', 'scheduled',
                   'en-route', 'at-client', 'picked-up', 'at-facility',
                   'weighed', 'processed', 'cert-draft', 'cert-issued',
                   'cert-sent', 'cancelled', 'postponed'],
        },
        rejectionReason: String,
        cancelledReason: String,
        scheduledDate: Date,
        acceptedAt: Date,
        acceptedBy: { userType: String, userId: mongoose.Schema.Types.ObjectId, name: String, _id: false },

        // Supervisor — polymorphic ref + denormalized snapshot
        supervisor: {
            userType: { type: String, enum: ['Admin', 'Manager', 'Employee'] },
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            phone: String,
            assignedAt: Date,
            assignedBy: mongoose.Schema.Types.ObjectId,
            _id: false,
        },

        // Evidence trail — one entry per status change
        evidence: [evidenceSchema],

        // Waste data entered after Processed status
        lineItems: [wasteLineItemSchema],
        totalKg: { type: Number, default: 0 },
        wasteDataEnteredAt: Date,
        wasteDataEnteredBy: { userType: String, userId: mongoose.Schema.Types.ObjectId, name: String, _id: false },

        // Cert — populated as cert moves through draft → issued → sent
        certificate: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate' },
    },
    { timestamps: true }
);

pickupSchema.index({ pickupID: 1 }, { unique: true });
pickupSchema.index({ client: 1, status: 1 });
pickupSchema.index({ status: 1, scheduledDate: 1 });
pickupSchema.index({ 'supervisor.userId': 1, status: 1 });
```

### 6.4 New: `Certificate.js`

```js
const certificateSchema = new mongoose.Schema(
    {
        certNumber: { type: String, required: true, unique: true }, // e.g. CoD-2026-0001
        revision: { type: Number, default: 1 },
        supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate' }, // previous revision

        pickup: { type: mongoose.Schema.Types.ObjectId, ref: 'Pickup', required: true },
        client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },

        status: {
            type: String,
            enum: ['draft', 'issued', 'sent', 'superseded'],
            default: 'draft',
        },
        // Snapshot of waste data at issuance — immutable
        lineItemsSnapshot: [{
            stream: String, qtyKg: Number, _id: false,
        }],
        totalKgSnapshot: Number,
        clientNameSnapshot: String,
        pickupDateSnapshot: Date,

        // S3 location of rendered PDF
        pdf: { key: String, bucket: String, _id: false },

        issuedAt: Date,
        issuedBy: { userType: String, userId: mongoose.Schema.Types.ObjectId, name: String, _id: false },
        sentAt: Date,
        sentBy: { userType: String, userId: mongoose.Schema.Types.ObjectId, name: String, _id: false },
    },
    { timestamps: true }
);

certificateSchema.index({ certNumber: 1 }, { unique: true });
certificateSchema.index({ client: 1, status: 1 });
certificateSchema.index({ pickup: 1 });
```

> **Storage note:** Certificate PDFs go to S3 under `cods/<year>/<certNumber>.pdf` with **NO lifecycle expiry** (these are legal records — see §19).

### 6.5 Existing models — small additions

```js
// In Admin.js, Manager.js, Employee.js — add these fields:
canSupervise: { type: Boolean, default: false },
canCoordinate: { type: Boolean, default: false },  // only meaningful for Manager+Admin in P1
```

### 6.6 New: `StatsSnapshot.js` (for the public live-stats cache)

```js
const statsSnapshotSchema = new mongoose.Schema(
    {
        key: { type: String, unique: true, default: 'public-live-stats' },
        totalKgDiverted: Number,
        totalCertsIssued: Number,
        totalClientsServed: Number,
        co2eAvoidedKg: Number,
        byStream: [{ stream: String, kg: Number, _id: false }],
        computedAt: Date,
    },
    { timestamps: true }
);
```

Recomputed every 15 minutes by a background job (see §12). Public `/api/public/stats` reads from this collection — never aggregates on the fly.

---

## 7. API Surface

All new endpoints. Mounted under existing route files where natural; one new file for client portal.

### 7.1 Admin — Client management (`/api/admin/clients`)

| Method + path | Purpose |
|---|---|
| `POST /api/admin/clients` | Create client (triggers onboarding email) |
| `GET /api/admin/clients` | List clients (filter by status, search by name/email) |
| `GET /api/admin/clients/:id` | Get full client detail |
| `PATCH /api/admin/clients/:id` | Update client fields |
| `DELETE /api/admin/clients/:id` | Soft-delete (sets `status='churned'`) |
| `POST /api/admin/clients/:id/resend-onboarding` | Regenerate token + resend email |

### 7.2 Admin / Coordinator — Pickup triage (`/api/admin/pickups`, `/api/manager/pickups`)

| Method + path | Purpose |
|---|---|
| `GET /api/admin/pickups?status=requested` | List requests awaiting acceptance |
| `GET /api/admin/pickups/:id` | Full pickup detail with evidence + timeline |
| `PATCH /api/admin/pickups/:id/accept` | Body: `{ scheduledDate, supervisorUserType, supervisorUserId }` |
| `PATCH /api/admin/pickups/:id/reject` | Body: `{ rejectionReason }` |
| `PATCH /api/admin/pickups/:id/reassign-supervisor` | Body: `{ supervisorUserType, supervisorUserId }` |
| `PATCH /api/admin/pickups/:id/cancel` | Body: `{ cancelledReason }` |
| `GET /api/admin/supervisor-pool` | Returns all users with `canSupervise: true` (for dropdown) |

### 7.3 Supervisor — Field execution

These routes are mounted on each role since supervisors can be any role:

| Method + path | Purpose |
|---|---|
| `GET /api/employee/my-pickups` | Pickups where `supervisor.userId === me` (+ status filters) |
| `GET /api/manager/my-pickups` | Same for managers |
| `GET /api/admin/my-pickups` | Same for admins |
| `PATCH /api/{role}/pickups/:id/status` | Body: `{ status, lat, lng }` + multipart `photo` (mandatory for status changes ≥ 'en-route') |
| `POST /api/{role}/pickups/:id/waste-data` | Body: `{ lineItems: [{ stream, qtyKg }] }` + optional multipart `weighbridgePhoto` |

### 7.4 Manager — Certificate workflow

| Method + path | Purpose |
|---|---|
| `POST /api/manager/certificates/draft` | Auto-generate draft from pickup data — returns draft for review |
| `PATCH /api/manager/certificates/:id/issue` | Lock the draft → status `issued`, generate PDF, store in S3 |
| `POST /api/manager/certificates/:id/send` | Email PDF link to client + push portal notification → status `sent` |
| `POST /api/manager/certificates/:id/revise` | Create a new cert that supersedes this one (kept for audit) |
| `GET /api/manager/certificates?status=draft` | List drafts awaiting review |

### 7.5 Client Portal (`/api/client/*`) — new auth surface

| Method + path | Purpose |
|---|---|
| `POST /api/client/onboarding/verify` | Body: `{ token }` — verify token validity, return client name + email for confirmation |
| `POST /api/client/onboarding/complete` | Body: `{ token, password }` — set password, mark onboarded |
| `POST /api/client/login` | Body: `{ email, password }` → JWT |
| `POST /api/client/forgot-password` | Body: `{ email }` — sends reset email (out of P1 scope if too tight; can defer) |
| `GET /api/client/me` | Returns client profile |
| `GET /api/client/dashboard` | Returns: stats (kg diverted, certs received, last pickup), upcoming scheduled pickups |
| `GET /api/client/pickups` | List own pickups (history + active) |
| `GET /api/client/pickups/:id` | Pickup detail with status timeline + supervisor info |
| `POST /api/client/pickups` | Request a pickup — body: `{ requestedDate, requestedStreams, clientNotes }` |
| `PATCH /api/client/pickups/:id/cancel` | Cancel own pickup (only if status is `requested` or `accepted` — not after en-route) |
| `GET /api/client/certificates` | List own certs |
| `GET /api/client/certificates/:id/download` | Returns presigned S3 URL for the PDF |
| `POST /api/client/subscribe` | Push subscription (mirrors employee/manager pattern) |

### 7.6 Public site (`/api/public/*`)

| Method + path | Purpose |
|---|---|
| `GET /api/public/stats` | Cached live stats for marketing site `/impact` page |

### 7.7 Auth middleware additions

- `middleware/authClient.js` — verifies `clientToken` JWT issued by `/api/client/login`. Attaches `req.client`.
- JWT subject claim: `{ id, kind: 'client' }`. Internal middlewares (`authAdmin`, `authManager`, `authEmployee`) reject `kind === 'client'` tokens and vice versa.

---

## 8. State Machines

### 8.1 Pickup Status

```
            ┌─────────────┐                  ┌──────────────┐
            │  requested  │ ───reject──▶    │  rejected    │ (terminal)
            └──────┬──────┘                  └──────────────┘
                   │ accept
                   ▼
            ┌─────────────┐                  ┌──────────────┐
            │  accepted   │ ──postpone──▶    │  postponed   │ ───reschedule──▶ scheduled
            └──────┬──────┘                  └──────────────┘
                   │ schedule
                   ▼
            ┌─────────────┐  client cancel
            │  scheduled  │ ──before en-route──▶ cancelled (terminal)
            └──────┬──────┘
                   │ supervisor: depart
                   ▼
            ┌─────────────┐
            │  en-route   │
            └──────┬──────┘
                   │ supervisor: arrived
                   ▼
            ┌─────────────┐
            │ at-client   │
            └──────┬──────┘
                   │ supervisor: collected
                   ▼
            ┌─────────────┐
            │ picked-up   │
            └──────┬──────┘
                   │ supervisor: arrived at facility
                   ▼
            ┌─────────────┐
            │ at-facility │
            └──────┬──────┘
                   │ supervisor / manager: weighed
                   ▼
            ┌─────────────┐
            │   weighed   │  ← waste-data form filled here
            └──────┬──────┘
                   │ system: data complete
                   ▼
            ┌─────────────┐
            │  processed  │
            └──────┬──────┘
                   │ system: cert auto-drafted
                   ▼
            ┌─────────────┐
            │ cert-draft  │
            └──────┬──────┘
                   │ manager: issue
                   ▼
            ┌─────────────┐
            │ cert-issued │
            └──────┬──────┘
                   │ manager: send
                   ▼
            ┌─────────────┐
            │  cert-sent  │ (terminal — happy path)
            └─────────────┘
```

**Allowed reverse transitions:** none in P1. (If a mistake happens after `cert-sent`, use cert revision workflow — see §11.)

**Photo evidence required at:** `en-route`, `at-client`, `picked-up`, `at-facility`, `weighed`. Optional but recommended at `at-client` (waste-before-loading photo).

**GPS captured at:** every supervisor-driven status change.

### 8.2 Certificate Status

```
              ┌──────────┐
              │  draft   │  ◀─── auto-generated when pickup reaches 'weighed'
              └────┬─────┘
                   │ manager: issue (+ PDF rendered to S3)
                   ▼
              ┌──────────┐
              │  issued  │  ◀─── immutable; locked from edits
              └────┬─────┘
                   │ manager: send (email + portal notification)
                   ▼
              ┌──────────┐
              │   sent   │  ◀─── visible to client; download enabled
              └────┬─────┘
                   │ manager: revise (creates new cert, marks old as superseded)
                   ▼
              ┌──────────────┐
              │  superseded  │
              └──────────────┘
```

---

## 9. Frontend Surface (Screens)

All screens use the existing React 19 + Tailwind + shadcn/ui stack.

### 9.1 Admin Dashboard — new tabs

| Tab | Screen |
|---|---|
| **Clients** | Searchable list · row click → detail · "+ New Client" button · status filter |
| **Pickup Requests** | Queue grouped by status (Requested / Accepted-not-scheduled / In-progress / Completed today) · accept/reject/assign buttons |
| **Certificates** | Drafts pending review · Issued (not yet sent) · Sent (audit log) |

### 9.2 Manager Dashboard — augmentations

- **My Pickups** sub-tab on the existing Manager dashboard if `canSupervise === true`
- **Pickup Triage** sub-tab if `canCoordinate === true`
- **Certificate Review** sub-tab (drafts assigned to me)

### 9.3 Employee Dashboard — augmentations

- **My Pickups** sub-tab if `canSupervise === true`
- Reuses the same camera modal we built for check-in selfies — pickup status photos use the same component

### 9.4 NEW: Client Portal (`/client/*`)

| Route | Screen |
|---|---|
| `/client/onboarding/:token` | Welcome card → set password → "Sign in" |
| `/client/login` | Email + password |
| `/client/dashboard` | Hero stats (kg diverted, CO₂e, last pickup, certs received) + upcoming pickups |
| `/client/pickups` | List of pickups (active highlighted at top, history below) |
| `/client/pickups/:id` | Live status timeline · supervisor card with name+phone · photos at each stage |
| `/client/pickups/new` | Request pickup form (date picker, streams checkboxes, notes) |
| `/client/certificates` | List of certificates with download buttons |
| `/client/profile` | Edit own contact details (re-onboarding doesn't change email; phone yes) |

The portal has its own light theme but reuses the same Tailwind palette (emerald/teal/cyan brand colors) and shadcn primitives.

### 9.5 Public site (`resrishti.com`)

- `/impact` page: replace hard-coded numbers with a fetch to `/api/public/stats`. Add a "last updated" footer line.
- Optional: add the live numbers to the homepage hero strip (was already designed to support it).

---

## 10. Magic-Link Onboarding & Client Portal Auth

### 10.1 Token mechanics

- Token: 32-byte cryptographically random, hex-encoded (64 chars in URL).
- Stored in `OnboardingToken` collection with `expiresAt = now + 7 days`, `usedAt = null`.
- Link format: `https://resrishti.com/client/onboarding/<token>`
- Single-use: once the client completes onboarding (sets password), `usedAt` is set and the token can never be reused.
- Resend: Admin clicks "Resend Onboarding" → previous unused tokens for that client are invalidated (set `expiresAt = now`), a new token is generated, new email sent.

### 10.2 Email content (Phase 1)

Sent via existing Nodemailer SMTP. Subject: "Welcome to Resrishti — finish setting up your account". Body includes:
- Brand-styled HTML template
- Welcome message
- Big "Activate Account" button → onboarding URL
- Expiry note: "Link expires in 7 days"
- Fallback raw URL in case the button is blocked

### 10.3 Client JWT

- Same `jsonwebtoken` library + `JWT_SECRET` as internal users.
- Token payload: `{ id: client._id, kind: 'client' }`.
- Expiry: 7 days (same as internal). Refresh-token flow is out of P1 scope.
- Client portal stores token in `localStorage` under `clientToken` (mirrors `employeeToken` / `managerToken`).

### 10.4 Security checks

- Token validation: not expired, not used, matches a Client whose `status === 'pending-onboarding'`.
- Rate-limit `/api/client/login` (5 attempts / 15 min per IP) using existing express-rate-limit.
- Password rules: ≥8 chars, mix of letters + numbers (configurable). Reject whitespace-only.
- All client password handling uses the same trim-on-hash-and-compare pattern from commit `671f3af`.

---

## 11. Certificate Generation

### 11.1 Trigger

When a pickup transitions to status `weighed` AND the waste-data form is submitted, the system auto-creates a `Certificate` record with `status: 'draft'`.

### 11.2 PDF rendering

- Library: **`@react-pdf/renderer`** (server-side React → PDF). Keeps everything in JS, easy to template, deterministic output.
- Template: single Resrishti-branded CoD template in P1. Renders the line items, weights, dates, pickup ID, cert number, manager signature image (stored on the manager profile), TGPCB compliance footer.
- PDF saved to S3 at `cods/<year>/<certNumber>.pdf` with permanent retention (no lifecycle).

### 11.3 Cert numbering

Format: `CoD-<YYYY>-<seq>` (e.g., `CoD-2026-0001`).
- Sequence is per-year, monotonically increasing.
- Stored in a small `Counter` collection (`{ key: 'cert-2026', value: 42 }`) and incremented atomically via `findOneAndUpdate` with `$inc`.

### 11.4 Send

When "Send Certificate" is clicked:
- Generate a presigned S3 URL (7-day expiry) for download.
- Email the client with the PDF as an attachment AND the portal link.
- Mark cert `sentAt`, `sentBy`. Push notification to client.

### 11.5 Revision (when data is wrong post-send)

- Manager clicks "Revise Certificate" on a sent cert.
- System creates a new Certificate (`revision: prev + 1`, `supersedes: oldCertId`), copies snapshot, opens it as draft.
- Manager edits waste data → issues → sends new cert.
- The old cert is marked `superseded` but remains downloadable for audit. The client portal shows revision history.

### 11.6 What's NOT in P1 cert template

- Form 4 (Biomedical Waste Management Rules) — Phase 2
- E-Waste Manifest format — Phase 2
- Hazardous Form 13 — Phase 2
- Digital signature certificate (DSC) integration — Phase 3

---

## 12. Public Site Live-Stats Integration

### 12.1 Computation

Background job runs every **15 minutes** (using `setInterval` in `server.js`, or `node-cron` if we want clean syntax):

```js
// pseudo
async function computePublicStats() {
    const agg = await Pickup.aggregate([
        { $match: { status: { $in: ['cert-issued', 'cert-sent'] } } },
        { $unwind: '$lineItems' },
        { $group: {
            _id: '$lineItems.stream',
            kg: { $sum: '$lineItems.qtyKg' },
        }},
    ]);
    const totalKg = agg.reduce((s, r) => s + r.kg, 0);
    const totalCerts = await Certificate.countDocuments({ status: 'sent' });
    const totalClients = await Client.countDocuments({ status: 'active' });
    const co2e = totalKg * /* avg emission factor */ 0.85;
    await StatsSnapshot.findOneAndUpdate(
        { key: 'public-live-stats' },
        { totalKgDiverted: totalKg, totalCertsIssued: totalCerts,
          totalClientsServed: totalClients, co2eAvoidedKg: co2e,
          byStream: agg.map(r => ({ stream: r._id, kg: r.kg })),
          computedAt: new Date() },
        { upsert: true }
    );
}
```

CO₂e calculation uses a per-stream emission-factor table (research + hard-code in P1, make it editable in P2). Sample table:

| Stream | kg CO₂e avoided per kg recycled |
|---|---|
| plastic | 1.5 |
| paper | 0.94 |
| ewaste | 1.44 |
| biomedical | 1.1 |
| dry-waste | 0.4 |
| ... | ... |

### 12.2 Endpoint

`GET /api/public/stats` reads from `StatsSnapshot` collection and returns cached values. Sub-millisecond response. Marketing site fetches on page load.

### 12.3 Privacy

- Public response contains **aggregate only** — no client names, no per-client kg.
- Per-stream breakdown is OK (industry-level info, not client-identifying).

---

## 13. Notification Plan

Reuses existing triple-channel mesh (web push + Socket.IO + email).

| Event | Recipients | Channels |
|---|---|---|
| Onboarding link sent | client | email |
| Client onboarding complete | admins (with `canCoordinate`) | push + in-app |
| Pickup requested | admins + managers with `canCoordinate` | push + email |
| Pickup accepted by coordinator | client | email + portal banner |
| Supervisor assigned | client AND supervisor | client: portal banner. supervisor: push (mobile) |
| Pickup status change (en-route, at-client, picked-up, at-facility) | client | portal banner + email (digestible — 1 email per pickup, not per status) |
| Waste data entered | manager (with `canCoordinate`) | push + in-app |
| Cert ready for review (Draft created) | manager (with `canCoordinate`) | push + in-app |
| Cert sent to client | client | email + portal notification + push (if subscribed) |

**Quiet hours respected:** existing `NotificationSettings` admin toggles apply.

---

## 14. Phase 1 Implementation Guide (Step-by-Step)

### Order matters. Each step should be a separate PR.

#### Step 1 — Schema additions to existing models (1–2 days)
- Add `canSupervise` and `canCoordinate` flags to `Admin.js`, `Manager.js`, `Employee.js`.
- Add API endpoints for Admin to toggle these flags on existing user-profile edit screens.
- Add UI toggles to the admin user-edit form (single checkbox each).
- **Migration:** Default both flags to `false`. Admin manually enables them after deploy.

#### Step 2 — Client model + CRUD (3–4 days)
- Implement `Client.js` model.
- Add `controllers/clientController.js` with `createClient`, `listClients`, `getClient`, `updateClient`, `deleteClient`.
- Add `routes/clientRoutes.js` mounted at `/api/admin/clients`.
- Add Admin Dashboard "Clients" tab with table + create-client modal.
- Validation: GSTIN format, email uniqueness, phone format (Indian by default).

#### Step 3 — Onboarding flow (2–3 days)
- Implement `OnboardingToken.js` model.
- Endpoint `POST /api/admin/clients/:id/resend-onboarding`.
- Email template for onboarding link (HTML + plaintext fallback).
- Endpoints `POST /api/client/onboarding/verify` and `POST /api/client/onboarding/complete`.
- Frontend: `pages/client/Onboarding.jsx` (token in route param).
- Smoke test: create client → email arrives → link works → password set → can login.

#### Step 4 — Client portal auth + dashboard shell (3 days)
- Implement `middleware/authClient.js`.
- Endpoint `POST /api/client/login` returning JWT.
- New auth route in App.jsx: `/client/*`.
- `pages/client/Dashboard.jsx` with empty stats card (filled later) + sidebar nav.
- Login + logout flow with `localStorage.clientToken`.

#### Step 5 — Pickup model + request flow (4–5 days)
- Implement `Pickup.js` model + pickupID generator (mirror `generateTaskId`).
- Endpoint `POST /api/client/pickups` (client requests pickup).
- Endpoint `GET /api/client/pickups` + `GET /api/client/pickups/:id`.
- Frontend `pages/client/PickupRequest.jsx` + `pages/client/PickupList.jsx` + `pages/client/PickupDetail.jsx`.
- Push notification to coordinators on new request.

#### Step 6 — Admin / Coordinator triage screens (4 days)
- Endpoints: `GET /api/admin/pickups?status=...`, `PATCH .../accept`, `PATCH .../reject`, `GET /api/admin/supervisor-pool`.
- Admin Dashboard "Pickup Requests" tab with queue layout.
- Accept-and-assign modal: scheduled date picker + supervisor dropdown.
- Real-time updates via Socket.IO (`pickup_<id>` room).

#### Step 7 — Supervisor field flow (5 days — the meatiest step)
- Endpoints for status transitions with photo evidence (multipart). Reuse existing S3 upload pattern.
- Endpoint `GET /api/{role}/my-pickups`.
- Frontend: "My Pickups" tab on Employee + Manager + Admin dashboards (visible only if `canSupervise`).
- Pickup detail screen with status-advance buttons. Each click opens the same camera modal we built for check-in. Photos go to S3 under `pickup-evidence/<pickupID>/`.
- GPS captured on each status change (mandatory).
- Note: pickup-evidence photos use a **30-day S3 lifecycle** (longer than check-in selfies, shorter than legal certs). Apply a new lifecycle rule `pickup-evidence-30d-expiry` via a new lifecycle script.

#### Step 8 — Waste data entry + cert auto-draft (4 days)
- After "weighed" status, supervisor sees a form to enter line items.
- Endpoint `POST /api/{role}/pickups/:id/waste-data`.
- On submission, system creates a `Certificate` with `status: 'draft'`, links to pickup.
- Pickup status flips to `processed` then `cert-draft`.
- Push notification to `canCoordinate` managers: "Cert draft ready for review".

#### Step 9 — Certificate review + render + send (5 days)
- Install `@react-pdf/renderer`. Build the CoD template component.
- Endpoint `PATCH /api/manager/certificates/:id/issue` — renders PDF, uploads to S3, marks `issued`.
- Endpoint `POST /api/manager/certificates/:id/send` — emails client with PDF attachment, marks `sent`.
- Frontend: Manager Dashboard "Certificates" tab with Drafts / Issued / Sent sections.
- Cert preview screen with "Issue" and "Send" buttons; preview iframe shows the PDF.

#### Step 10 — Client portal: pickup journey + certificate downloads (3 days)
- Pickup detail screen on client portal: status timeline visualization, supervisor card with name + phone, photos at each completed stage.
- Cert tab on client portal: list + download button (presigned URL).
- Auto-refresh via Socket.IO when status changes.

#### Step 11 — Public stats endpoint + `/impact` migration (2 days)
- Implement `StatsSnapshot.js`.
- Background job in `server.js` running every 15 min.
- Endpoint `GET /api/public/stats`.
- Update marketing site `ImpactDashboard.jsx` to fetch this endpoint and replace hard-coded numbers.

#### Step 12 — End-to-end QA + polish (3–4 days)
- Test the full flow: admin creates client → onboarding → request → accept → supervise → cert → client downloads.
- Mobile responsive check on all client portal screens (the client likely opens it on phone).
- Performance check: pickup detail with 10+ status events + photos shouldn't lag.
- Error states: expired token, rejected request, cancelled pickup, etc.

#### Total estimated Phase 1 effort
**~40 dev-days** = ~8 weeks for one engineer, or ~5 weeks for one backend + one frontend in parallel.

---

## 15. Phase 2 — WhatsApp, Recurring, Compliance Cert Templates

### 15.1 WhatsApp Integration

- **Provider:** AiSensy or Interakt (Indian aggregators built on Meta Cloud API). Recommended over going direct to Meta initially — handles template-approval workflows and provides a friendlier dashboard.
- **Templates to approve:** onboarding link, pickup confirmed, pickup en-route, pickup completed, cert sent. Each takes 1–3 days for Meta to approve.
- **Cost estimate:** ~₹0.60 per outbound message (utility/service category). For 100 active clients with ~4 messages each per pickup × 4 pickups/month → ~₹960/month.
- **Fallback chain:** WhatsApp → SMS (Twilio India) → Email.
- **Opt-in:** Client portal setting "Receive WhatsApp updates" with default ON. Stored on client document.

### 15.2 Recurring Pickup Contracts

- New `PickupContract` model:
  ```js
  {
      client, frequency: ('daily'|'weekly'|'biweekly'|'monthly'),
      dayOfWeek (for weekly), dayOfMonth (for monthly),
      streams: [String], startDate, endDate,
      autoAssignSupervisor (optional default),
  }
  ```
- Background job creates upcoming `Pickup` records 14 days in advance from active contracts.
- Client portal shows "Next pickup" widget pulling from contract schedule.

### 15.3 Stream-Specific Compliance Cert Templates

| Stream | Template required | Reference |
|---|---|---|
| Biomedical | Form 4 (BMWM Rules 2016) | CPCB |
| E-waste | E-Waste Manifest (E-Waste Mgmt Rules 2022) | CPCB |
| Hazardous | Form 13 (Hazardous Waste Mgmt Rules 2016) | CPCB |
| Plastic | Branded CoD (no statutory form) | n/a |
| Paper, dry-waste, etc. | Branded CoD | n/a |

Each form has specific mandatory fields (manifest number, transporter details, lot tracking). The Phase 2 work is replacing the single-template renderer with a template-per-stream switch.

### 15.4 Notification preferences per client

- Client-side preference center: pickup status (yes/no per channel), cert delivery (yes/no per channel), monthly summary (yes/no).
- Backend honors preferences in `notifyClient(event, payload)` helper.

---

## 16. Phase 3 — Multi-Contact, Multi-Branch, Invoicing, Portal Maturity

### 16.1 Multi-contact per client

- Replace `contactName/Email/Phone` fields with a `contacts: [{ name, email, phone, role, isPrimary }]` array.
- Each contact gets its own portal login (different email per contact).
- Permissions per contact (procurement / accounts / sustainability).
- Migration: existing client's single contact becomes the array's primary.

### 16.2 Multi-branch per client

- New `Branch` sub-model on Client.
- Pickup gets a `branch` reference instead of just `pickupAddressSnapshot`.
- Branch-level pickup requests (each branch may have its own contact + supervisor preference).
- CoDs can be issued per-branch (legal entities sometimes need branch-level docs).

### 16.3 Invoicing

- `Invoice` model: rate-card × kg = line items, GST, payment terms.
- Auto-batch monthly per client.
- Razorpay integration for online payment (UPI / card).
- Aged-receivables dashboard for admin.

### 16.4 Portal maturity

- Two-factor auth (TOTP).
- Audit log: who logged in, who downloaded which cert, when.
- Bulk download (Q1 / Q2 / annual all-certs zip).
- Export pickup history as CSV.
- Embeddable widget for client's own intranet showing their stats.

### 16.5 Operations

- Driver / vehicle management.
- Route optimization for multi-stop pickup days.
- Capacity planning (which streams' processing lines are full).
- Two-person sign-off for waste data on loads > 1000 kg.

---

## 17. Open Questions (Needs Decision)

These are the questions still to resolve. They don't block starting Phase 1 — sensible defaults are noted — but should be settled before the relevant feature is built.

### Onboarding & auth

1. **Onboarding link expiry — 7 days OK, or shorter (24h, 72h) for security?**
   *Default: 7 days.*

2. **Password complexity rule** — ≥8 chars + mixed alphanumeric, or stricter (special char required)?
   *Default: ≥8 chars, ≥1 letter + ≥1 number.*

3. **After client completes onboarding, do they enter the portal immediately, or does Admin need to approve the activation?**
   *Default: immediately (no admin gate).*

4. **Should the onboarding form let the client edit their phone / address / GSTIN, or only set password?**
   *Default: editable — make onboarding feel ownership-y.*

### Pickup lifecycle

5. **Can the client edit a pickup request after submitting (before acceptance)?**
   *Suggested: yes, until status moves past `requested`.*

6. **Can the client cancel after the team has accepted but before en-route?**
   *Suggested: yes, with reason. After en-route: no.*

7. **SLA for "accept the request" — how fast must a coordinator respond?**
   *Suggested: 4 business hours. Auto-escalate to all admins if not accepted in 12 hours.*

8. **Can a supervisor be reassigned mid-flow (after en-route)?**
   *Suggested: yes by admin, with audit trail. The client should be notified.*

### Cert workflow

9. **Who has authority to ISSUE certs in Phase 1 — Admin only, or any Manager with `canCoordinate`?**
   *Suggested: Admin or Manager with `canCoordinate`.*

10. **Cert number sequence — global, per-year, or per-client?**
    *Suggested: per-year, global (`CoD-2026-0001`).*

11. **Should the Send button require typing the client's email as a confirmation (typo guard)?**
    *Suggested: yes — high-value action.*

12. **What's the retention policy for certs in S3?**
    *Default: permanent (no lifecycle expiry). See §19.*

### Waste data

13. **Mandatory fields per stream — is `qtyKg` always enough, or do specific streams need extra?**
    Examples:
    - E-waste: device count, IMEI / serial for high-value items?
    - Biomedical: bag count, color-code?
    *Suggested: P1 = qtyKg only. P2 introduces per-stream extra fields.*

14. **Should the weighbridge photo be mandatory or optional in P1?**
    *Suggested: optional in P1, mandatory in P2.*

15. **What if total weight is 0 (mistaken pickup, nothing collected)? Cert should still issue, or skip?**
    *Suggested: skip cert — pickup ends in `cancelled` with reason `nothing-to-collect`.*

### Public stats

16. **What's the cache TTL for `/api/public/stats` — 15 min OK or longer?**
    *Default: 15 min.*

17. **What CO₂e emission factors do we use, and who signs off on them?**
    *Need: industry-standard reference (e.g., CPCB's GHG calculator, or Indian Bureau of Energy Efficiency). Defer specific numbers to a senior decision but use placeholder values in P1.*

18. **Should the public site show real-time numbers or daily snapshots ("yesterday's impact")?**
    *Suggested: real-time (the 15-min cache is fine).*

### Roles & access

19. **In P1, what specifically can a Coordinator do that a Manager-without-`canCoordinate` can't?**
    Coordinator = receive new-pickup-request notifications, accept/reject, assign supervisors.
    Manager without it = supervise pickups assigned to them, enter waste data, but NOT triage requests.
    *Confirm this split.*

20. **Should certain users be auto-enrolled as Coordinators (e.g., all Admins)?**
    *Suggested: yes — all Admins get `canCoordinate: true` by default. Managers opt-in.*

### Misc

21. **Magic-link sender email — should we set up `noreply@resrishti.com` with SPF/DKIM, or use the existing SMTP `FROM_EMAIL`?**
    *Suggested: dedicated `noreply@resrishti.com` for portal emails. One-day DNS task.*

22. **Branding on the client portal — full Resrishti theme or a slightly distinct "client portal" sub-brand?**
    *Suggested: same Resrishti theme, no sub-brand. Reuses existing color palette + logo.*

23. **Multi-language support — English only, or Hindi / Telugu support since clients are in Telangana?**
    *Suggested: English only in P1. i18n hooks for P3.*

24. **Where do we store the manager's signature image used in the cert?**
    *Suggested: optional field on Manager profile, uploaded once. Default fallback to a generic Resrishti chairperson signature image.*

25. **What happens if a client's account is `paused` — can they still log in to view past certs?**
    *Suggested: yes (read-only), but can't request new pickups.*

---

## 18. Edge Cases & Validations

### Onboarding

- Token used twice → first use wins, second use returns 400 with "Already used".
- Token expired → 410 Gone with "Expired — contact your Resrishti account manager for a new link".
- Email already exists (another client with same email) → 409 on Client create; prompt to use a different email.
- Client tries to onboard but Admin had deleted their record → 404.

### Pickup request

- Client submits two pickup requests within 10 minutes → allow but flag visually for coordinator ("possible duplicate").
- Client requests pickup for a past date → reject with 400.
- Client requests pickup with no streams checked → reject with 400.
- Pickup accepted but supervisor never assigned (coordinator forgot to fill supervisor dropdown) → can't accept; UI blocks.
- Pickup accepted with `scheduledDate` in past → reject.

### Supervisor flow

- Supervisor tries to skip a status (e.g., en-route → at-facility without picked-up) → backend rejects, returns valid next-status list.
- Supervisor uploads a photo > 5 MB → multer rejects with 413.
- Supervisor's GPS times out / denied → photo still uploads but GPS lat/lng stored as `null`. Status change still allowed (don't block field work on GPS hiccups).
- Same supervisor assigned two pickups for the same hour → allow but warn ("conflict") on assignment.

### Waste data

- Negative qtyKg → reject.
- Stream not in enum → reject.
- All line items sum to 0 → block cert generation, prompt for confirmation that the pickup yielded nothing.
- Duplicate stream entries in the same form → server merges (sum the kg) and warns the user.

### Certificate

- Cert generation attempted but template renderer fails (PDF lib error) → leave cert in `draft`, return 500 with details; don't change pickup status.
- Cert issued but send fails (SMTP down) → keep cert as `issued`, retry send later; expose a retry button.
- Manager clicks Send twice rapidly → idempotency guard: only one send event recorded.
- Cert revision created but never issued → admin can discard (the cert is just deleted; the original sent cert stays valid).
- Client downloads cert after presigned URL expires → portal automatically generates a fresh presigned URL on each click.

### Client portal

- Client uses an invalid JWT (expired, tampered) → 401, redirect to `/client/login`.
- Client tries to view another client's pickup by guessing the ID → 403 (mandatory ownership check on every `/api/client/pickups/:id` query).
- Concurrent edit: client cancels a pickup while coordinator is in the middle of assigning → use optimistic concurrency (`updatedAt` check); UI shows "This pickup was just updated, refresh".

### Public stats

- Stats snapshot stale (background job crashed → snapshot is >1h old) → endpoint still returns the stale snapshot but with `computedAt` exposed; UI shows the timestamp.
- Negative or impossible numbers → defensive: never return negative, clamp at 0.

### Data integrity

- Client soft-deleted (status `churned`) but still has open pickups → don't allow status `churned` if any pickup is in active state. Force the admin to first cancel open pickups.
- Pickup with `wasteDataEnteredAt` set but no `lineItems` → impossible by design; add a Mongoose validator.
- Pickup history must remain accessible even if a supervisor user is deleted → snapshot fields (name, phone) make this safe; refs are nullable.

---

## 19. Compliance Notes (TGPCB / CPCB)

> **Disclaimer:** This is engineering-side guidance, not legal advice. Get the templates reviewed by a compliance officer before production use.

### Retention

| Document | Retention | Storage |
|---|---|---|
| Certificate of Disposal (CoD) | **Permanent** (legal record) | S3 `cods/` — NO lifecycle rule |
| Pickup evidence photos | 30 days (sufficient for client dispute window) | S3 `pickup-evidence/` — 30-day lifecycle |
| Check-in selfies (existing) | 7 days | S3 `checkin-photos/` — 7-day lifecycle |
| Onboarding tokens | 7 days post-expiry | MongoDB TTL index |
| Audit logs (cert send, status changes) | ≥5 years | MongoDB (no expiry) |

### Stream-specific forms (deferred to Phase 2)

| Stream | Form | Issued by | Key fields |
|---|---|---|---|
| Biomedical | Form 4 (BMWM Rules 2016) | Resrishti as Common Bio-medical Waste Treatment Facility (CBWTF) | manifest no., generator (hospital) details, transporter, weight per category color (yellow/red/white/blue), date of treatment |
| E-Waste | E-Waste Manifest (E-Waste Mgmt Rules 2022) | Resrishti as authorized recycler | producer/dealer/refurbisher details, EPR registration no., quantities |
| Hazardous | Form 13 (HOWM Rules 2016) | Resrishti as Treatment, Storage, Disposal Facility (TSDF) | nature of waste, quantity, disposal route |

The Phase 1 cert is a **branded "Certificate of Disposal"** template that's suitable for non-statutory streams (plastic, paper, dry-waste, AGR). For biomedical / e-waste / hazardous clients, manual statutory forms still need to be issued out-of-band until Phase 2.

---

## 20. Integration Points with Existing Modules

| Existing | How Client Mgmt plugs in |
|---|---|
| Public site `/contact` form | Phase 2: auto-creates a Lead. Phase 1: still goes to email. |
| Employee / Manager dashboard | New "My Pickups" sub-tab if `canSupervise === true` |
| Employee check-in selfie (camera modal) | **Reused as-is** for pickup-status photos |
| Geo-location service / Leaflet trail | Reused for pickup GPS pins |
| Push notification system | Reused — new event types (`pickup-request`, `pickup-assigned`, `cert-ready`, etc.) added to existing categories |
| Email service (Nodemailer) | Reused for onboarding, cert delivery |
| S3 utilities | Reused — new prefixes `clients/`, `pickup-evidence/`, `cods/` |
| Socket.IO | Reused — new rooms `pickup_<id>` for live status updates to clients |
| Rate limiter | Reused — apply login-limiter to `/api/client/login` |
| Auth pattern (JWT) | Reused — new `authClient` middleware mirrors the existing three |
| Admin notification settings (toggles) | Extend to include new event categories |

---

## 21. Success Criteria & Metrics

### Phase 1 — leading indicators (first 30 days post-launch)

| Metric | Target |
|---|---|
| Clients onboarded | ≥10 |
| Pickup requests received via portal | ≥30 |
| Average time from request → accept | < 4 business hours |
| Certs generated end-to-end via app | ≥20 |
| Client portal login rate (% of onboarded clients) | ≥70% |
| Manual CoD generation (out-of-band) | ↓ by 80% within 30 days |

### Phase 1 — qualitative

- A client receives a CoD within **5 minutes** of waste being weighed (vs. 1–2 days today)
- Coordinator says they have a single screen to manage all in-flight pickups
- Marketing site `/impact` page shows live numbers without a code deploy

### Phase 2/3 — to track later

- WhatsApp delivery rate, opt-in rate
- DSO reduction after invoicing module ships
- Client portal engagement (logins / week, certs downloaded / month)
- Renewal rate at contract end

---

## 22. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Client portal onboarding adoption is low (clients don't open the email) | Portal is optional — admin can mark a client "operational" without onboarding and still issue certs. Onboarding rate gets measured + improved via subject-line A/B. |
| Coordinator forgets to assign a supervisor → pickup stuck | Daily digest email to admins: "X pickups accepted >24h with no supervisor". |
| Supervisor uploads wrong photo (e.g., screenshot of phone) | Manager review at cert-issue stage is the audit gate. Photos are previewed before issue. |
| Compliance officer rejects Phase 1 cert format | We ship Phase 1 as a non-statutory CoD only. Statutory forms come in Phase 2 with proper templates reviewed. |
| Public site live stats stop updating (background job crash) | Snapshot exposes `computedAt`; UI shows the timestamp. Add health-check alert if `computedAt > 1h old`. |
| Storage costs balloon (photos per pickup) | 30-day lifecycle on pickup-evidence; ~50 KB per photo × 5 photos per pickup × 100 pickups/month = ~25 MB/month at S3 → trivially cheap. |
| Client wants their data deleted (DPDP-style request) | Implement a soft-delete + cert-archive flow in P3. In P1, document the manual process (admin marks client `churned`, archives certs to a separate folder). |

---

## 23. Appendix — Sample data

### A pickup at end-of-flow

```json
{
  "pickupID": "PU-20260512-A7F2",
  "client": "65f3...",
  "clientNameSnapshot": "Apollo Hospital, Hyderabad",
  "pickupAddressSnapshot": "Plot 42, Jubilee Hills, Hyderabad, 500033",
  "requestedAt": "2026-05-11T09:14:22Z",
  "requestedDate": "2026-05-12",
  "requestedStreams": ["biomedical"],
  "clientNotes": "Daily collection; entrance near Block C",
  "status": "cert-sent",
  "scheduledDate": "2026-05-12T10:00:00Z",
  "acceptedAt": "2026-05-11T10:02:11Z",
  "acceptedBy": { "userType": "Admin", "userId": "...", "name": "Priya R" },
  "supervisor": {
    "userType": "Employee", "userId": "...",
    "name": "Mahesh K", "phone": "+919876543210",
    "assignedAt": "2026-05-11T10:02:11Z", "assignedBy": "..."
  },
  "evidence": [
    { "status": "en-route", "photo": { "key": "pickup-evidence/PU-20260512-A7F2/en-route.jpg", "bucket": "resrishti" }, "gps": { "lat": 17.4239, "lng": 78.4738 }, "at": "2026-05-12T09:55:00Z", "by": {...} },
    { "status": "at-client", "photo": {...}, "gps": {...}, "at": "2026-05-12T10:08:00Z", "by": {...} },
    { "status": "picked-up", "photo": {...}, "gps": {...}, "at": "2026-05-12T10:22:00Z", "by": {...} },
    { "status": "at-facility", "photo": {...}, "gps": {...}, "at": "2026-05-12T11:14:00Z", "by": {...} },
    { "status": "weighed", "photo": { "key": "pickup-evidence/PU-20260512-A7F2/weighbridge.jpg", "bucket": "resrishti" }, "gps": null, "at": "2026-05-12T11:35:00Z", "by": {...} }
  ],
  "lineItems": [
    { "stream": "biomedical", "qtyKg": 42.5, "weighbridgePhoto": { "key": "...", "bucket": "resrishti" } }
  ],
  "totalKg": 42.5,
  "wasteDataEnteredAt": "2026-05-12T11:38:00Z",
  "wasteDataEnteredBy": { "userType": "Employee", "userId": "...", "name": "Mahesh K" },
  "certificate": "65f4..."
}
```

### A certificate sent to client

```json
{
  "certNumber": "CoD-2026-0173",
  "revision": 1,
  "pickup": "65f3...",
  "client": "65f3...",
  "status": "sent",
  "lineItemsSnapshot": [{ "stream": "biomedical", "qtyKg": 42.5 }],
  "totalKgSnapshot": 42.5,
  "clientNameSnapshot": "Apollo Hospital, Hyderabad",
  "pickupDateSnapshot": "2026-05-12",
  "pdf": { "key": "cods/2026/CoD-2026-0173.pdf", "bucket": "resrishti" },
  "issuedAt": "2026-05-12T12:05:00Z",
  "issuedBy": { "userType": "Manager", "userId": "...", "name": "S. Ravi" },
  "sentAt": "2026-05-12T12:06:14Z",
  "sentBy": { "userType": "Manager", "userId": "...", "name": "S. Ravi" }
}
```

---

*End of spec. Last updated 2026-05-10. Update this file as Phase 1 progresses — every architectural decision should land here so engineers six months from now can find it.*
