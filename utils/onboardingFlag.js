/*
  onboardingFlag — single source of truth for the "client onboarding enabled"
  switch, so the route guard and the client-create flow never drift apart.

  Behavior:
  - Onboarding is ENABLED by default (preserves existing production behavior if
    the env var is absent).
  - Set CLIENT_ONBOARDING_ENABLED=false to temporarily disable the client-facing
    onboarding magic-link flow (verify/complete) and stop new invite emails.
    Nothing is deleted — flip it back to re-enable with zero code changes.
*/
function isClientOnboardingEnabled() {
  return String(process.env.CLIENT_ONBOARDING_ENABLED).toLowerCase() !== "false";
}

// Express guard for the public onboarding endpoints. 503 (not 404) so the
// client clearly sees "temporarily unavailable" rather than "gone".
function requireOnboardingEnabled(req, res, next) {
  if (!isClientOnboardingEnabled()) {
    return res.status(503).json({
      message: "Client onboarding is temporarily disabled.",
    });
  }
  return next();
}

module.exports = { isClientOnboardingEnabled, requireOnboardingEnabled };
