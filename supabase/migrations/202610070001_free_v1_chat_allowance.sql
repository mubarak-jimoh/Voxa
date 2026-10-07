-- Raise free Talk allowance for genuine companion use while keeping per-account caps.
update public.entitlement_limits
set
  daily_limit = 150,
  monthly_limit = 3000,
  updated_at = now()
where plan = 'free' and metric = 'ai_messages';
