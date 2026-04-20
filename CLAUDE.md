# Project: Resrishti Task & Attendance Management System

## Architecture

- **Backend:** Node.js/Express + MongoDB (Mongoose) + JWT auth + S3 for file storage
- **Frontend:** React 19 + Vite + Tailwind CSS + Shadcn/Radix UI + Socket.IO
- **Branch:** `feature/attendence`

### Three-Level Org Structure

```
Admin (top level)
  └── Manager (mid level, created by Admin)
        └── Employee (created by Manager)
```

---

## Session Changes Log

### 1. Admin Organization Management (Manager CRUD + Leave Oversight)

**Backend:**

- `controllers/adminOrgController.js` — **NEW** — Admin endpoints for:
  - Manager CRUD: create, list (with employee counts), update, delete (blocks if employees assigned)
  - Employee oversight: list all employees, reassign employee to different manager
  - Leave oversight: view all leave requests org-wide, admin override approve/reject any leave
  - Org overview: aggregated stats (total managers, employees, combined leave counts from both Employee Leave + ManagerLeave)
- `models/Leave.js` — **MODIFIED** — Added `adminOverride` (Boolean), `adminReviewedBy` (ref Admin), `adminRemarks` (String) fields
- `models/Admin.js` — **MODIFIED** — Added `pushSubscription` field for push notifications
- `routes/adminRoutes.js` — **MODIFIED** — Added routes: `GET/POST /managers`, `PUT/DELETE /managers/:id`, `GET /employees`, `PATCH /employees/:id/reassign`, `GET /leaves`, `PATCH /leaves/:id`, `GET /org/overview`
- `controllers/attendanceController.js` — **MODIFIED** — `applyLeave` now notifies all admins via push
- `controllers/attendanceManagerController.js` — **MODIFIED** — `reviewLeave` now notifies all admins of leave decision outcome

**Frontend:**

- `components/admin/AdminManagersTab.jsx` — **NEW** — Full CRUD UI for managers with expandable employee lists, search, reassignment dropdowns
- `components/admin/AdminLeavesTab.jsx` — **NEW** — All leave requests with status filters, search, admin remarks input, approve/reject override buttons
- `components/admin/AdminOrgOverview.jsx` — **NEW** — Dashboard showing total managers/employees/leave stats and expandable org tree
- `pages/AdminDashboard.jsx` — **MODIFIED** — Added Dashboard, Managers, Leaves sidebar tabs (Dashboard is now default tab). Renamed existing tabs to "Emp. Attendance" and added "Mgr. Attendance"

---

### 2. Manager Attendance Tracking (Manager as Employee, Admin as Supervisor)

**Backend:**

- `models/ManagerAttendance.js` — **NEW** — Mirrors Attendance.js with `manager` ref instead of `employee`
- `models/ManagerLeave.js` — **NEW** — Mirrors Leave.js with `manager` ref, `reviewedBy` refs Admin
- `models/ManagerCorrectionRequest.js` — **NEW** — Mirrors CorrectionRequest.js with `manager` ref
- `controllers/managerSelfAttendanceController.js` — **NEW** — Manager's own attendance (check-in/out, calendar, corrections, leaves) — mirrors employee attendance controller exactly, with admin as supervisor
- `controllers/adminManagerAttendanceController.js` — **NEW** — Admin oversight of manager attendance (team view, monthly summary, approve attendance, review corrections, approve/reject leaves with calendar marking)
- `routes/managerRoutes.js` — **MODIFIED** — Added 9 self-attendance routes under `/self-attendance/*`
- `routes/adminRoutes.js` — **MODIFIED** — Added 7 manager-attendance oversight routes under `/manager-attendance/*`

**Frontend:**

- `components/attendance/ManagerSelfAttendanceTab.jsx` — **NEW** — Full attendance UI for managers (check-in/out with geolocation, calendar, corrections, leave request with balances) — mirrors employee attendance tab
- `components/admin/AdminManagerAttendanceTab.jsx` — **NEW** — Admin view for managing manager attendance (today's status, monthly summary, correction review, leave approval)
- `pages/ManagerDashboard.jsx` — **MODIFIED** — Added "My Attendance" sidebar tab, renamed "Attendance" to "Team Attendance"
- `pages/AdminDashboard.jsx` — **MODIFIED** — Added "Mgr. Attendance" sidebar tab

---

### 3. Attendance Correction Request Fix

**Backend:**

- `controllers/attendanceController.js` — **MODIFIED** — Fixed correction request: properly converts `HH:MM` time strings from `<input type="time">` to full Date objects using the attendance record's date. Previously `new Date("09:30")` produced `Invalid Date`
- `controllers/managerSelfAttendanceController.js` — **MODIFIED** — Same fix applied for manager correction requests

**Frontend:**

- `components/attendance/ManagerSelfAttendanceTab.jsx` — **MODIFIED** — Fixed unicode escapes (`\u2014`, `\u2192`) in JSX text that rendered literally instead of as `—` and `→` characters
- `components/admin/AdminManagerAttendanceTab.jsx` — **MODIFIED** — Same unicode fix

---

### 4. Org Overview Leave Count Fix

- `controllers/adminOrgController.js` — **MODIFIED** — `getOrgOverview` now aggregates both `Leave` (employee) and `ManagerLeave` counts so admin dashboard shows combined totals

---

### 5. Profile System & First-Time Login Setup

**Backend:**

- `models/Employee.js` — **MODIFIED** — Added 16 profile fields: `isFirstLogin`, `isProfileComplete`, `profilePhoto`, `dateOfBirth`, `gender`, `phone`, `personalEmail`, `emergencyContactName`, `emergencyContactPhone`, `currentAddress`, `idProofType`, `idProofNumber`, `idProofDocument`, `jobRole`, `department`, `joiningDate`
- `models/Manager.js` — **MODIFIED** — Same 16 profile fields added
- `controllers/profileController.js` — **NEW** — Unified profile management:
  - Employee: change password (marks `isFirstLogin=false`), get/update own profile (with local file uploads for photo & ID doc)
  - Manager: change password, get/update own profile, view/edit employee profiles (job fields only)
  - Admin: view/edit any employee or manager profile (all fields including job fields)
  - Auto-computes `isProfileComplete` based on required fields (name, DOB, gender, phone, address)
  - File uploads saved locally to `uploads/profiles/` and `uploads/id-proofs/` using multer diskStorage
- `controllers/employeeController.js` — **MODIFIED** — Login returns `isFirstLogin` & `isProfileComplete`
- `controllers/managerController.js` — **MODIFIED** — Login returns `isFirstLogin` & `isProfileComplete`; `createEmployee` accepts `jobRole`, `department`, `joiningDate`
- `controllers/adminOrgController.js` — **MODIFIED** — `createManager` and `updateManager` accept `jobRole`, `department`, `joiningDate`
- `routes/employeeRoutes.js` — **MODIFIED** — Added `POST /profile/change-password`, `GET /profile`, `PUT /profile` (multipart)
- `routes/managerRoutes.js` — **MODIFIED** — Added `POST /profile/change-password`, `GET /profile`, `PUT /profile` (multipart), `GET /employees/:id/profile`, `PATCH /employees/:id/profile`
- `routes/adminRoutes.js` — **MODIFIED** — Added `GET/PATCH /employees/:id/profile`, `GET/PATCH /managers/:id/profile`

**Frontend:**

- `pages/SetupWizard.jsx` — **NEW** — Two-step mandatory setup flow:
  - Step 1: Force password change with current/new/confirm fields
  - Step 2: Profile form (personal details, contact info, ID proofs, read-only job details)
  - Step indicator with progress visualization
  - Redirects to dashboard on completion, clears `needsSetup` flag
- `components/profile/ProfilePage.jsx` — **NEW** — Full profile management page:
  - Profile header card with avatar (shows uploaded photo or initial), name, email, role
  - Completion progress bar with percentage
  - Editable sections: Personal Details, Contact Info, ID Proof (with file upload)
  - Read-only Job Details section (set by organization)
  - Password change section
  - View/edit toggle mode
- `pages/EmployeeLogin.jsx` — **MODIFIED** — Redirects to `/employee/setup` if `isFirstLogin || !isProfileComplete`
- `pages/ManagerLogin.jsx` — **MODIFIED** — Redirects to `/manager/setup` if `isFirstLogin || !isProfileComplete`
- `App.jsx` — **MODIFIED** — Added `/employee/setup` and `/manager/setup` routes; updated redirect logic with `needsSetup` localStorage flag
- `pages/EmployeeDashboard.jsx` — **MODIFIED** — Added "My Profile" sidebar tab with ProfilePage component
- `pages/ManagerDashboard.jsx` — **MODIFIED** — Added "My Profile" sidebar tab with ProfilePage component
- `components/admin/AdminManagersTab.jsx` — **MODIFIED** — Manager creation/edit form now includes Job Role, Department, Joining Date fields
- `pages/ManagerDashboard.jsx` — **MODIFIED** — Employee creation form now includes Job Role, Department, Joining Date fields

---

### 6. Profile Photo Upload Fix

- `controllers/profileController.js` — **MODIFIED** — Changed file uploads from S3 (`uploadFile`) to local disk storage (`multer.diskStorage`). Files saved to `uploads/profiles/` and `uploads/id-proofs/` served via existing static middleware
- `components/profile/ProfilePage.jsx` — **MODIFIED** — Fixed broken `process.env.S3_BUCKET_NAME` reference (undefined in browser) replaced with simple `${API}/${profile.profilePhoto}` URL construction. Added actual `<img>` rendering for profile photos
- `server.js` — **MODIFIED** — Configured `helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } })` to allow frontend to load images from backend's `/uploads` static path

---

### 7. Continuous Location Tracking (Check-in to Check-out)

**Backend:**

- `models/LocationTrail.js` — **NEW** — Stores continuous location points per user per day
  - Supports both `employee` and `manager` refs (sparse unique compound indexes)
  - `locations` array of `{ lat, lng, accuracy, timestamp }`
  - 90-day TTL auto-cleanup index
- `controllers/locationController.js` — **NEW** — 5 endpoints:
  - `POST /api/employee/location/batch` — Employee sends buffered location points
  - `POST /api/manager/location/batch` — Manager sends buffered location points
  - `GET /api/manager/location/trail/:employeeId/:date` — Manager views employee trail
  - `GET /api/admin/location/trail/employee/:employeeId/:date` — Admin views employee trail
  - `GET /api/admin/location/trail/manager/:managerId/:date` — Admin views manager trail
- `routes/employeeRoutes.js` — **MODIFIED** — Added `POST /location/batch`
- `routes/managerRoutes.js` — **MODIFIED** — Added `POST /location/batch`, `GET /location/trail/:employeeId/:date`
- `routes/adminRoutes.js` — **MODIFIED** — Added `GET /location/trail/employee/:id/:date`, `GET /location/trail/manager/:id/:date`

**Frontend:**

- `services/locationTracker.js` — **NEW** — PWA-compatible location tracking service:
  - `startTracking(apiBase, token)` — starts `navigator.geolocation.watchPosition`, buffers points, syncs every 2 min
  - `stopTracking()` — stops watching, final flush of buffer
  - Auto-retry on network failure (pushes back to buffer)
  - 50m distance filter to reduce noise and battery drain
- `components/location/TrailMap.jsx` — **NEW** — Reusable trail viewer component:
  - User dropdown + date picker filters
  - Stats cards (point count, first/last seen time, date)
  - Leaflet map with polyline trail, start/latest markers with popups
  - Scrollable location timeline with time, coordinates, accuracy
  - Empty state for dates with no data
  - Leaflet default icon fix for bundled builds
- `components/attendance/CheckInOut.jsx` — **MODIFIED** — Integrated `startTracking("employee", token)` on check-in, `stopTracking()` on check-out, auto-resumes on page load if mid-shift
- `components/attendance/ManagerSelfAttendanceTab.jsx` — **MODIFIED** — Same tracking integration with `"manager"` apiBase
- `components/attendance/ManagerAttendanceTab.jsx` — **MODIFIED** — Added "Location" sub-tab with employee trail viewer
- `components/attendance/AdminAttendanceTab.jsx` — **MODIFIED** — Added "Emp. Location" sub-tab with employee trail viewer
- `components/admin/AdminManagerAttendanceTab.jsx` — **MODIFIED** — Added "Location" sub-tab with manager trail viewer

**Packages Installed (Frontend):**
- `leaflet@1.9.4`
- `react-leaflet`

---

## API Endpoint Summary

### Employee Routes (`/api/employee`)
- `POST /login` — Login (returns isFirstLogin, isProfileComplete)
- `POST /profile/change-password` — Change password
- `GET /profile` — Get own profile
- `PUT /profile` — Update profile (multipart: profilePhoto, idProofDocument)
- `POST /location/batch` — Send batched location points
- (existing attendance, task, leave routes unchanged)

### Manager Routes (`/api/manager`)
- `POST /login` — Login (returns isFirstLogin, isProfileComplete)
- `POST /profile/change-password` — Change password
- `GET /profile` — Get own profile
- `PUT /profile` — Update profile (multipart)
- `GET /employees/:id/profile` — View employee profile
- `PATCH /employees/:id/profile` — Edit employee job fields
- `POST /self-attendance/checkin` — Manager check-in
- `POST /self-attendance/checkout` — Manager check-out
- `GET /self-attendance/today` — Today's record
- `GET /self-attendance/calendar` — Monthly calendar
- `POST /self-attendance/correction` — Submit correction
- `GET /self-attendance/corrections` — View corrections
- `GET /self-attendance/leaves` — View leaves + balances
- `POST /self-attendance/leaves` — Apply for leave
- `GET /self-attendance/policy` — Get policy
- `POST /location/batch` — Send batched location points
- `GET /location/trail/:employeeId/:date` — View employee trail
- (existing team attendance, task, employee CRUD routes unchanged)

### Admin Routes (`/api/admin`)
- `GET/POST /managers` — List/create managers (with jobRole, department, joiningDate)
- `PUT/DELETE /managers/:id` — Update/delete manager
- `GET /employees` — List all employees
- `PATCH /employees/:id/reassign` — Reassign employee to manager
- `GET /leaves` — All employee leave requests
- `PATCH /leaves/:id` — Admin override approve/reject leave
- `GET /org/overview` — Org structure + combined leave stats
- `GET /manager-attendance/team` — All managers attendance for date
- `GET /manager-attendance/team/summary` — Monthly manager summary
- `PATCH /manager-attendance/:id/approve` — Approve/reject manager attendance
- `GET /manager-attendance/corrections` — Manager correction requests
- `PATCH /manager-attendance/corrections/:id` — Review manager correction
- `GET /manager-attendance/leaves` — Manager leave requests
- `PATCH /manager-attendance/leaves/:id` — Approve/reject manager leave
- `GET/PATCH /employees/:id/profile` — View/edit employee profile
- `GET/PATCH /managers/:id/profile` — View/edit manager profile
- `GET /location/trail/employee/:id/:date` — View employee location trail
- `GET /location/trail/manager/:id/:date` — View manager location trail
- (existing attendance policy, testimonial, blog routes unchanged)

---

## File Upload Storage

Profile photos and ID proof documents are stored **locally** under:
- `uploads/profiles/` — Profile photos
- `uploads/id-proofs/` — ID proof documents

Served via `express.static("uploads")` at `/uploads/*` path. Helmet configured with `crossOriginResourcePolicy: "cross-origin"` to allow frontend access.

---

## Key Technical Decisions

- **Separate models for manager attendance** (`ManagerAttendance`, `ManagerLeave`, `ManagerCorrectionRequest`) rather than modifying existing employee models — avoids breaking existing flows
- **Local file storage** for profile uploads instead of S3 — simpler setup, served via existing static middleware
- **PWA-first location tracking** using `navigator.geolocation.watchPosition` with 2-min batch sync — works in browsers without Capacitor, with buffer-and-retry on network failure
- **Leaflet/OpenStreetMap** for trail visualization — free, no API key needed
- **90-day TTL** on location trail data via MongoDB TTL index
