-- Customers: one row per business or person Portlandica sells to.
--
-- Part of the data foundation (docs/data-foundation.md). These migrations assume the
-- live schema was captured first with `supabase db pull`, and that the login/auth
-- migration (which defines public.is_partner()) has already run.

do $$
begin
  if to_regprocedure('public.is_partner()') is null then
    raise exception 'public.is_partner() is missing: apply the login/auth migration before this one';
  end if;
end
$$;

-- Internal helpers live here so they are not exposed through the REST API.
create schema if not exists private;

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

revoke execute on function private.touch_updated_at() from public;

create table public.customers (
  id bigint generated always as identity primary key,
  name text not null,
  -- "Hotel Vintage" and "hotel vintage " are the same customer.
  name_key text generated always as (lower(btrim(name))) stored,
  type text not null default 'business',
  business_type text,
  parent_company text,
  price_per_can numeric(10, 2),
  custom_cans boolean not null default false,
  payment_terms_days integer,
  street_address text,
  city text,
  state text,
  zip text,
  latitude double precision,
  longitude double precision,
  email text,
  square_customer_id text,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Names are stored trimmed: no leading or trailing whitespace, never empty.
  constraint customers_name_trimmed check (name ~ '^\S(.*\S)?$'),
  constraint customers_name_key_key unique (name_key),
  constraint customers_type_valid check (type in ('business', 'individual')),
  constraint customers_price_positive check (price_per_can > 0),
  constraint customers_terms_valid check (payment_terms_days between 0 and 365),
  constraint customers_email_valid check (email ~ '^[^@\s]+@[^@\s]+$'),
  constraint customers_lat_lng_pair check ((latitude is null) = (longitude is null)),
  constraint customers_latitude_range check (latitude between -90 and 90),
  constraint customers_longitude_range check (longitude between -180 and 180)
);

create unique index customers_square_customer_id_key on public.customers (square_customer_id)
  where square_customer_id is not null;
create index customers_parent_company_idx on public.customers (parent_company)
  where parent_company is not null;

create trigger customers_touch_updated_at
  before update on public.customers
  for each row execute function private.touch_updated_at();

comment on table public.customers is
  'Businesses and people Portlandica sells to. Custom-can batches and sales orders point here.';
comment on column public.customers.name_key is
  'Trimmed, lowercased name. Unique; use it to look customers up by name.';
comment on column public.customers.type is 'business or individual (the Sales sheet''s Type column).';
comment on column public.customers.business_type is
  'Kind of business, e.g. Restaurant, Cafe, Hotel (the locations tab''s Type of Business).';
comment on column public.customers.parent_company is
  'Group the customer belongs to, from the Sales sheet''s Parent Companies tab.';
comment on column public.customers.price_per_can is
  'Agreed price per can in dollars. NULL means the default price (DEFAULT_PRICE_PER_CAN, $1.50).';
comment on column public.customers.custom_cans is 'True when the customer buys custom-printed cans.';
comment on column public.customers.payment_terms_days is
  'Invoice terms in days (Sysco is 65). NULL means the default terms (30 days).';
comment on column public.customers.email is 'Where invoices go, when known.';
comment on column public.customers.square_customer_id is 'Matching customer id in Square, once linked.';
comment on column public.customers.active is 'False hides the customer without deleting history.';

alter table public.customers enable row level security;

create policy "Partners manage customers"
  on public.customers
  for all
  to authenticated
  using ((select public.is_partner()))
  with check ((select public.is_partner()));

revoke all on table public.customers from anon;
