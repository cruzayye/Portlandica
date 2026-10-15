-- Take TRUNCATE away from the API roles on every table in public.
--
-- Supabase's default grants give anon and authenticated every table privilege, TRUNCATE
-- included, and TRUNCATE ignores row level security. The Data API can't send a TRUNCATE,
-- so this is defence in depth: nothing in the app, and no partner, needs to empty a
-- whole table through these roles.
--
-- It runs last so it also covers the tables the earlier migrations created.
--
-- Undo (not expected to be needed):
--   grant truncate on all tables in schema public to anon, authenticated;

revoke truncate on all tables in schema public from anon, authenticated;
