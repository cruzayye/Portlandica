import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { decideAccess } from '@/lib/auth/access'
import { getAllowlist } from '@/lib/auth/allowlist'

// Next.js 16 renamed middleware.ts to proxy.ts. It lives in src/ because the
// app does (src/app). It runs on the Node.js runtime by default.
//
// It refreshes the Supabase session and sends anyone who isn't a signed-in
// partner to /login. It is only the first gate: every server action also
// checks the caller with requireUser().
export const proxy = async (request: NextRequest) => {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh and verify the session. Do not add code between
  // createServerClient() and getClaims(), or users can be signed out at random.
  const { data } = await supabase.auth.getClaims()

  const decision = decideAccess({
    pathname: request.nextUrl.pathname,
    isServerAction: request.method === 'POST' && request.headers.has('next-action'),
    user: data?.claims ?? null,
    allowlist: getAllowlist(),
  })
  if (decision.allow) return supabaseResponse

  // Carry over any refreshed (or cleared) session cookies to the redirect.
  const redirect = NextResponse.redirect(new URL(decision.redirectTo, request.url))
  supabaseResponse.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie))
  return redirect
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
