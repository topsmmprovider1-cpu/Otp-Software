-- ============================================================
-- OTP Software - Supabase schema
-- Supabase Dashboard -> SQL Editor -> paste & RUN this once.
-- ============================================================

create table if not exists public.users (
  id            bigserial primary key,
  full_name     text not null,
  email         text not null unique,
  phone         text,
  password_hash text not null,
  balance       numeric(12,2) not null default 0,
  role          text not null default 'user' check (role in ('admin','user')),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists public.numbers (
  id         bigserial primary key,
  number     text not null,
  country    text not null,
  platform   text not null,
  price      numeric(12,2) not null default 0,
  api_url    text,
  status     text not null default 'available' check (status in ('available','sold','disabled')),
  created_at timestamptz not null default now()
);

create index if not exists idx_numbers_find
  on public.numbers(status, country, platform);

create table if not exists public.orders (
  id           bigserial primary key,
  order_id     text not null unique,
  user_id      bigint not null references public.users(id),
  number_id    bigint references public.numbers(id),
  number       text not null,
  country      text not null,
  platform     text not null,
  price        numeric(12,2) not null,
  status       text not null default 'pending'
                 check (status in ('pending','completed','cancelled','expired')),
  otp_code     text,
  otp_message  text,
  otp_time     timestamptz,
  pull_count   int not null default 0,
  api_url      text not null default '',
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  cancelled_at timestamptz
);

create index if not exists idx_orders_user   on public.orders(user_id);
create index if not exists idx_orders_status on public.orders(status);

create table if not exists public.otp_logs (
  id         bigserial primary key,
  order_id   bigint references public.orders(id),
  number     text,
  code       text,
  message    text,
  created_at timestamptz not null default now()
);

create index if not exists idx_otp_logs_order on public.otp_logs(order_id);

-- Services master lists (countries / platforms)
create table if not exists public.platforms (
  id         bigserial primary key,
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.countries (
  id         bigserial primary key,
  name       text not null unique,
  created_at timestamptz not null default now()
);

-- A "service" = a platform + country offering with a price and its own api_url
create table if not exists public.services (
  id         bigserial primary key,
  platform   text not null,
  country    text not null,
  price      double precision not null default 0,
  api_url    text not null default '',
  status     text not null default 'enabled',
  created_at timestamptz not null default now(),
  unique (platform, country)
);
create index if not exists idx_services_status on public.services(status);

-- API keys for external API access
create table if not exists public.api_keys (
  id         bigserial primary key,
  user_id    bigint not null references public.users(id) on delete cascade,
  api_key    text not null unique,
  label      text not null default 'Default',
  last_used  timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_api_keys_user on public.api_keys(user_id);

-- Support tickets
create table if not exists public.tickets (
  id         bigserial primary key,
  user_id    bigint not null references public.users(id) on delete cascade,
  subject    text not null,
  category   text not null default 'general',
  status     text not null default 'open' check (status in ('open','answered','closed')),
  priority   text not null default 'normal' check (priority in ('low','normal','high')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at  timestamptz
);
create index if not exists idx_tickets_user   on public.tickets(user_id);
create index if not exists idx_tickets_status on public.tickets(status);

create table if not exists public.ticket_messages (
  id          bigserial primary key,
  ticket_id   bigint not null references public.tickets(id) on delete cascade,
  sender_id   bigint references public.users(id),
  sender_role text not null default 'user',
  message     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_tm_ticket on public.ticket_messages(ticket_id);

-- Wallet / transaction history
create table if not exists public.wallet_entries (
  id         bigserial primary key,
  user_id    bigint not null references public.users(id) on delete cascade,
  amount     numeric(12,2) not null,
  type       text not null default 'adjustment'
               check (type in ('deposit','purchase','refund','adjustment')),
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists idx_wallet_user on public.wallet_entries(user_id);

-- Poller per-attempt logs (what the SMS API returned for a pending order)
create table if not exists public.order_pull_logs (
  id         bigserial primary key,
  order_id   bigint references public.orders(id),
  number     text,
  result     text not null default 'poll',
  message    text,
  code       text,
  error      text,
  attempt    int,
  created_at timestamptz not null default now()
);
create index if not exists idx_opl_order on public.order_pull_logs(order_id);

-- UPI / payment records (BharatPe UTR verification)
create table if not exists public.payments (
  id          bigserial primary key,
  user_id     bigint not null references public.users(id) on delete cascade,
  utr         text not null unique,
  amount      numeric(12,2) not null,
  method      text not null default 'BharatPe',
  credit      numeric(12,2) not null default 0,
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  note        text,
  ip          text,
  verified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_payments_user   on public.payments(user_id);
create index if not exists idx_payments_status on public.payments(status);

-- Key/value site settings
create table if not exists public.settings (
  key   text primary key,
  value text not null
);

-- Refresh-token sessions (persistent logins per device)
create table if not exists public.sessions (
  id           bigserial primary key,
  user_id      bigint not null references public.users(id) on delete cascade,
  role         text not null default 'user',
  token_hash   text not null unique,
  device_fp    text,
  device_name  text,
  ip           text,
  user_agent   text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '30 days'),
  revoked_at   timestamptz
);
create index if not exists idx_sessions_user on public.sessions(user_id);
create index if not exists idx_sessions_hash on public.sessions(token_hash);

-- Login / security events (recent activity feed)
create table if not exists public.login_activity (
  id          bigserial primary key,
  user_id     bigint not null references public.users(id) on delete cascade,
  type        text not null default 'login',
  detail      text,
  device_fp   text,
  device_name text,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_activity_user on public.login_activity(user_id);

-- Broadcast schema to PostgREST (makes new tables queryable immediately)
notify pgrst, 'reload schema';

-- NOTE: Admin account app start par automatically create hota hai
-- (.env ke ADMIN_EMAIL / ADMIN_PASSWORD se). KoI manual seed ki zaroorat nahi.