'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import { getAipNumbers } from '@/app/actions/aip'
import { isAuthFailure } from '@/lib/auth/authFailure'

/** Where A.I.P Numbers lived before it moved into the app. Shown until the app's copy is set up. */
export const STANDALONE_DASHBOARD_URL = 'https://portlandica-dashboard.vercel.app/'

/** The page that draws the dashboard: public/aip/index.html. */
export const AIP_PAGE = '/aip/index.html'

/** What this component sends the page. The page sends back only { type: 'aip:refresh' }. */
export type AipFrameMessage =
  | { type: 'aip:loading' }
  | { type: 'aip:data'; json: string }
  | { type: 'aip:error'; message: string }

const frameStyle = { width: '100%', height: '100%', border: 'none' }

/**
 * The A.I.P Numbers tab. The dashboard page runs in a sandboxed frame without
 * allow-same-origin, so it can't use the app's session or reach its data. This component
 * fetches the numbers with a server action and posts them to the frame; the page's
 * Refresh button asks for them again.
 */
const AipNumbers = () => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const loading = useRef(false)
  const [standalone, setStandalone] = useState(false)

  const post = useCallback((message: AipFrameMessage) => {
    // The sandboxed page's origin is opaque ("null"), so '*' is the only target that reaches it.
    frameRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  const load = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    post({ type: 'aip:loading' })
    try {
      const result = await getAipNumbers()
      if (isAuthFailure(result)) post({ type: 'aip:error', message: result.authError })
      else if ('json' in result) post({ type: 'aip:data', json: result.json })
      else if (result.notSetUp) setStandalone(true)
      else post({ type: 'aip:error', message: result.error })
    } catch {
      post({ type: 'aip:error', message: 'Could not load the numbers. Check the connection and try again.' })
    } finally {
      loading.current = false
    }
  }, [post])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (event.data?.type === 'aip:refresh') void load()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [load])

  return (
    <Box sx={{ width: '100%', height: 'calc(100vh - 120px)' }}>
      {standalone ? (
        <iframe src={STANDALONE_DASHBOARD_URL} style={frameStyle} title="A.I.P Numbers" />
      ) : (
        <iframe
          ref={frameRef}
          src={AIP_PAGE}
          sandbox="allow-scripts"
          onLoad={() => void load()}
          style={frameStyle}
          title="A.I.P Numbers"
        />
      )}
    </Box>
  )
}

export default AipNumbers
