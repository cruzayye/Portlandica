import { NextResponse, type NextRequest } from 'next/server'
import { decideAccess } from '@/lib/auth/access'
import { checkAuthConfig } from '@/lib/auth/config'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth/session'

// Next.js 16 renamed middleware.ts to proxy.ts. It lives in src/ because the app does
// (src/app). Proxy always runs on the Node.js runtime, so node:crypto is available.
//
// It sends anyone without a valid team session cookie to /login. It is only the first
// gate: every server action also checks the cookie with requireUser(). If TEAM_PASSWORD
// or SESSION_SECRET is missing or too short, no cookie is valid and everyone lands on
// /login, which says sign-in isn't set up.
export const proxy = (request: NextRequest) => {
  const auth = checkAuthConfig(process.env)
  const token = request.cookies.get(SESSION_COOKIE)?.value

  const decision = decideAccess({
    pathname: request.nextUrl.pathname,
    isServerAction: request.method === 'POST' && request.headers.has('next-action'),
    signedIn: auth.ok && verifySessionToken(token, auth.config),
  })
  if (decision.allow) return NextResponse.next()
  return NextResponse.redirect(new URL(decision.redirectTo, request.url))
}

// Skipped: Next's static files and images, so the sign-in page can load them, and public/aip/,
// the A.I.P Numbers page. That page holds no numbers: the signed-in app fetches them and posts
// them into its sandboxed frame (src/components/AipNumbers), so it needs no session to load.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|aip/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
