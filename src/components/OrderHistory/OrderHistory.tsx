'use client'

import { useEffect, useState, useTransition } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Paper from '@mui/material/Paper'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { listOrders, voidOrder } from '@/app/actions/orderHistory'
import { isAuthFailure } from '@/lib/auth/authFailure'
import { batchTitle } from '@/lib/batches'
import type { SalesOrderWithLines } from '@/lib/db/types'
import { describeSheetRef } from '@/lib/orders'
import { sheetDate } from '@/lib/delivery'
import type { OrderHistory as History } from '@/types/orders'
import OrderStatus from './OrderStatus'

const money = (dollars: number) =>
  Number(dollars).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const DELIVERY = { drop: 'Drop', ship: 'Ship', pickup: 'Pickup' } as const

// A void deletes the order's Square draft and records its Square step as skipped.
const draftDeleted = (order: SalesOrderWithLines) =>
  Boolean(order.square_invoice_id) && order.square_status === 'skipped'

// What a void leaves for a person: the app doesn't edit Sales rows, or a Square invoice
// that was already sent (or that it couldn't delete).
const reminders = (order: SalesOrderWithLines) => [
  ...(order.sheet_ref
    ? [`${describeSheetRef(order.sheet_ref)} still show this order: fix them by hand.`]
    : []),
  ...(order.square_invoice_id && !draftDeleted(order)
    ? [
        "Its Square invoice wasn't deleted: delete it in Square if it's still a draft, or cancel or refund it by hand.",
      ]
    : []),
]

/** Recent orders with how each step went, a retry for unfinished steps, and Void. */
export default function OrderHistory() {
  const [history, setHistory] = useState<History | null>(null)
  const [loads, setLoads] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [voiding, setVoiding] = useState<SalesOrderWithLines | null>(null)
  const [reason, setReason] = useState('')
  const [handFixes, setHandFixes] = useState<Record<number, string[]>>({})
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let current = true
    listOrders()
      .then((result) => {
        if (!current) return
        if (isAuthFailure(result)) setError(result.authError)
        else {
          setHistory(result)
          setError(result.error)
        }
      })
      .catch(() => {
        if (current) setError("Couldn't load the orders. Reload the page.")
      })
    return () => {
      current = false
    }
  }, [loads])

  const replace = (order: SalesOrderWithLines) =>
    setHistory(
      (prev) => prev && { ...prev, orders: prev.orders.map((o) => (o.id === order.id ? order : o)) }
    )

  const batchName = (id: number) => {
    const batch = history?.batches.find((b) => b.id === id)
    return batch ? batchTitle(batch) : `Batch ${id}`
  }

  const confirmVoid = () => {
    const order = voiding
    if (!order) return
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof voidOrder>>
      try {
        result = await voidOrder(order.id, reason)
      } catch {
        startTransition(() =>
          setError("Couldn't reach the server, so the order may not be void. Reload to check.")
        )
        return
      }
      // Updates after an await need their own transition to land with the end of this one.
      startTransition(() => {
        if (isAuthFailure(result)) setError(result.authError)
        else if (result.status === 'failed') setError(result.message)
        else {
          replace(result.order)
          setHandFixes((prev) => ({ ...prev, [order.id]: result.handFixes }))
          setVoiding(null)
          setReason('')
        }
      })
    })
  }

  return (
    <Box display="flex" flexDirection="column" gap={2} sx={{ width: '100%', maxWidth: 560 }}>
      <Box display="flex" justifyContent="space-between" alignItems="center">
        <Typography variant="h5" fontWeight={600}>
          Order History
        </Typography>
        <Button size="small" onClick={() => setLoads((n) => n + 1)}>
          Refresh
        </Button>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}
      {!history && !error && (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress aria-label="Loading orders" />
        </Box>
      )}
      {history && history.orders.length === 0 && !history.error && (
        <Typography color="text.secondary">No orders yet.</Typography>
      )}

      {history?.orders.map((order) => (
        <Paper
          key={order.id}
          component="article"
          aria-label={`Order ${order.id}`}
          elevation={1}
          sx={{
            p: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            opacity: order.voided_at ? 0.8 : 1,
          }}
        >
          <Box display="flex" justifyContent="space-between" alignItems="flex-start" gap={1}>
            <Box minWidth={0}>
              <Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
                {order.customer_name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                #{order.id} · {sheetDate(order.order_date)} · {DELIVERY[order.delivery_type]}
                {order.delivery_date ? ` ${sheetDate(order.delivery_date)}` : ''}
              </Typography>
            </Box>
            <Box textAlign="right" flexShrink={0}>
              <Typography fontWeight={600}>
                {order.is_donation ? 'Donation' : money(order.total_price)}
              </Typography>
              {order.voided_at && <Chip size="small" color="default" label="Void" />}
            </Box>
          </Box>

          <Typography variant="body2">
            {order.lines
              .map(
                (line) =>
                  `${line.cans.toLocaleString('en-US')} cans from ${batchName(line.batch_id)}${line.is_custom ? ' (Custom)' : ''}`
              )
              .join(' · ')}
          </Typography>
          {order.po_number && (
            <Typography variant="body2" color="text.secondary">
              PO {order.po_number}
            </Typography>
          )}

          {order.voided_at ? (
            <>
              <Typography variant="body2" color="text.secondary">
                Void: {order.void_reason}
              </Typography>
              {draftDeleted(order) && (
                <Typography variant="body2" color="text.secondary">
                  Its draft invoice was deleted in Square.
                </Typography>
              )}
              {(handFixes[order.id] ?? reminders(order)).map((fix) => (
                <Alert key={fix} severity="warning">
                  {fix}
                </Alert>
              ))}
            </>
          ) : (
            <>
              <OrderStatus order={order} onChange={replace} />
              <Box>
                <Button
                  size="small"
                  color="error"
                  onClick={() => {
                    setReason('')
                    setVoiding(order)
                  }}
                >
                  Void
                </Button>
              </Box>
            </>
          )}
        </Paper>
      ))}

      <Dialog open={!!voiding} onClose={() => setVoiding(null)} fullWidth>
        <DialogTitle>Void order #{voiding?.id}?</DialogTitle>
        <DialogContent>
          <Typography gutterBottom>
            Its cans go back to their batches, its Trello card is archived and its Square invoice is
            deleted if it is still a draft. Sales sheet rows, and an invoice already sent from
            Square, are not changed; you&apos;ll be told what to fix by hand.
          </Typography>
          <TextField
            label="Why?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            fullWidth
            autoFocus
            margin="dense"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setVoiding(null)}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            disabled={isPending || !reason.trim()}
            onClick={confirmVoid}
          >
            {isPending ? 'Voiding...' : 'Void Order'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
