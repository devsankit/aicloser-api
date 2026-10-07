INSERT INTO "AppDripCampaign" (
  "id", "name", "trigger", "audiences", "delayMinutes", "cooldownMinutes",
  "maxSendsPerUser", "localWindowStart", "localWindowEnd", "titleTemplate",
  "bodyTemplate", "destination", "stopCondition", "isActive", "updatedAt"
)
VALUES
  (
    'default-agency-profile-reminder',
    'Agency onboarding reminder',
    'PROFILE_INCOMPLETE',
    ARRAY['AGENCY']::"ConnectedAudience"[],
    180,
    1440,
    5,
    '09:00',
    '20:00',
    'Finish setting up your Gigxomi agency',
    '{{firstName}}, complete your agency profile to unlock your dashboard, Team, and client work.',
    '/connected-onboarding',
    '{"stopWhen":"profileDoneAt"}'::jsonb,
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'default-freelancer-onboarding-reminder',
    'Freelancer qualification reminder',
    'PROFILE_INCOMPLETE',
    ARRAY['FREELANCER']::"ConnectedAudience"[],
    180,
    1440,
    7,
    '09:00',
    '20:00',
    'Complete your Gigxomi editor profile',
    '{{firstName}}, finish your profile, portfolio, and dynamic Q&A so Gigxomi can review your work for the marketplace.',
    '/connected-onboarding',
    '{"stopWhen":"freelancerOnboardingCompletedAt"}'::jsonb,
    true,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "trigger" = EXCLUDED."trigger",
  "audiences" = EXCLUDED."audiences",
  "delayMinutes" = EXCLUDED."delayMinutes",
  "cooldownMinutes" = EXCLUDED."cooldownMinutes",
  "maxSendsPerUser" = EXCLUDED."maxSendsPerUser",
  "localWindowStart" = EXCLUDED."localWindowStart",
  "localWindowEnd" = EXCLUDED."localWindowEnd",
  "titleTemplate" = EXCLUDED."titleTemplate",
  "bodyTemplate" = EXCLUDED."bodyTemplate",
  "destination" = EXCLUDED."destination",
  "stopCondition" = EXCLUDED."stopCondition",
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;
