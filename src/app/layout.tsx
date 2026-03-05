import type { Metadata } from 'next'
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter'
import ThemeRegistry from '@/components/ThemeRegistry/ThemeRegistry'
import './globals.css'

export const metadata: Metadata = {
  title: 'App',
  description: '',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <AppRouterCacheProvider>
          <ThemeRegistry>{children}</ThemeRegistry>
        </AppRouterCacheProvider>
      </body>
    </html>
  )
}
