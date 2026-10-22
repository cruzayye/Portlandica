-- Some customers are invoiced outside Square: Market of Choice is billed through its own
-- spreadsheet. For them the order flow never makes a Square draft, even with Create Invoice
-- on; Create Invoice still marks the order's Sales row.
alter table public.customers
  add column invoiced_outside_square boolean not null default false;

comment on column public.customers.invoiced_outside_square is
  'Invoiced outside Square: the order flow never makes a Square draft for this customer.';
