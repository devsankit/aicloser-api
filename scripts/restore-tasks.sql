CREATE TABLE IF NOT EXISTS public.gx_lead_tasks (
    id text NOT NULL PRIMARY KEY,
    "salesLeadId" text NOT NULL,
    "ownerAgentId" text,
    "createdById" text,
    title text NOT NULL,
    description text,
    priority text DEFAULT 'NORMAL'::text NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    "dueAt" timestamp(3) without time zone NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "gx_lead_tasks_createdById_createdAt_idx" ON public.gx_lead_tasks USING btree ("createdById", "createdAt");
CREATE INDEX IF NOT EXISTS "gx_lead_tasks_ownerAgentId_status_dueAt_idx" ON public.gx_lead_tasks USING btree ("ownerAgentId", status, "dueAt");
CREATE INDEX IF NOT EXISTS "gx_lead_tasks_salesLeadId_status_dueAt_idx" ON public.gx_lead_tasks USING btree ("salesLeadId", status, "dueAt");

INSERT INTO public.gx_lead_tasks (id, "salesLeadId", "ownerAgentId", "createdById", title, description, priority, status, "dueAt", "completedAt", "createdAt", "updatedAt") VALUES
('cmv24v5b6004xggjpwrdc33kz', 'cmv22l2jd003fggjp9xw1mla4', 'cmv22jfp80039ggjpoh6xvumg', 'user-sales-agent-d182e0c9', 'demo ke liye', 'acha client hai', 'HIGH', 'OPEN', '2026-10-13 05:30:00', NULL, '2026-10-10 08:29:26.562', '2026-10-10 08:29:26.562'),
('cmv2620ca054lggjpwlcqxx9t', 'cmv22l2jd003fggjp9xw1mla4', 'cmv22jfp80039ggjpoh6xvumg', 'user-sales-agent-d182e0c9', 'noti', 'fbzzk', 'NORMAL', 'OPEN', '2026-10-22 05:30:00', NULL, '2026-10-10 09:02:46.33', '2026-10-10 09:02:46.33'),
('cmvc4f47u000smbjplueouh5n', 'cmv6e4ipa002xtnjpv2jm1cml', NULL, NULL, 'Scheduled WhatsApp follow-up callback with test 1', NULL, 'HIGH', 'OPEN', '2026-10-17 09:15:00', NULL, '2026-10-17 08:14:40.41', '2026-10-17 08:14:40.41'),
('cmvc4h162000tmbjpn03bpfpq', 'cmv6e4ipa002xtnjpv2jm1cml', NULL, NULL, 'Scheduled WhatsApp follow-up callback with test 1', NULL, 'HIGH', 'OPEN', '2026-10-17 09:17:00', NULL, '2026-10-17 08:16:09.77', '2026-10-17 08:16:09.77')
ON CONFLICT (id) DO NOTHING;
