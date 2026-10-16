'use client'

import { useState, useTransition } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import { retryOrder } from '@/app/actions/orderHistory'
import { isAuthFailure } from '@/lib/auth/authFailure'
import { STEP_ORDER, pendingSteps } from '@/lib/db/orders'
import type { OrderStep, SalesOrderWithLines, StepStatus } from '@/lib/db/types'
import type { Shortfall } from '@/types/orders'
import { describeSheetRef, shortfallMessage } from '@/lib/orders'

export const STEP_LABELS: Record<OrderStep, string> = {
  sheet: 'Sales sheet',
  inventory: 'Inventory',
  trello: 'Trello',
  square: 'Square',
}

const STATUS_TEXT: Record<StepStatus, string> = {
  done: 'done',
  failed: 'failed',
  pending: 'not run',
  skipped: 'skipped',
}

const STATUS_COLOR = {
  done: 'success',
  failed: 'error',
  pending: 'warning',
  skipped: 'default',
} as const

const stepDetail = (order: SalesOrderWithLines, step: OrderStep) => {
  if (step === 'sheet' && order.sheet_ref) return describeSheetRef(order.sheet_ref)
  if (step === 'square' && order.square_invoice_id) return 'Draft invoice made; send it from Square'
  if (step === 'square' && order.square_status === 'skipped' && order.create_invoice) {
    return 'No draft made: make the invoice in Square'
  }
  return null
}

type Props = {
  order: SalesOrderWithLines
  /** Called with the order as it stands after a retry. */
  onChange: (order: SalesOrderWithLines) => void
}

/** How each step of an order went, with a retry for the ones that didn't finish. */
export default function OrderStatus({ order, onChange }: Props) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [short, setShort] = useState<Shortfall[]>([])

  const pending = order.voided_at ? [] : pendingSteps(order)

  const retry = (allowNegativeInventory = false) => {
    setError(null)
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof retryOrder>>
      try {
        result = await retryOrder(order.id, { allowNegativeInventory })
      } catch {
        startTransition(() =>
          setError("Couldn't reach the server. Try again; finished steps won't run twice.")
        )
        return
      }
      // Updates after an await need their own transition to land with the end of this one.
      startTransition(() => {
        if (isAuthFailure(result)) setError(result.authError)
        else if (result.status === 'failed') setError(result.message)
        else {
          onChange(result.order)
          setWarnings(result.warnings)
          setShort(result.shortfalls)
        }
      })
    })
  }

  return (
    <Box display="flex" flexDirection="column" gap={1}>
      <Box
        display="flex"
        flexWrap="wrap"
        gap={1}
        component="ul"
        sx={{ m: 0, p: 0, listStyle: 'none' }}
      >
        {STEP_ORDER.map((step) => {
          const status = order[`${step}_status`]
          return (
            <li key={step}>
              <Chip
                size="small"
                variant={status === 'done' ? 'outlined' : 'filled'}
                color={STATUS_COLOR[status]}
                label={`${STEP_LABELS[step]}: ${STATUS_TEXT[status]}`}
              />
            </li>
          )
        })}
      </Box>

      {STEP_ORDER.map((step) => {
        const detail = stepDetail(order, step)
        const failure = order[`${step}_status`] === 'failed' ? order[`${step}_error`] : null
        return (
          (detail || failure) && (
            <Typography
              key={step}
              variant="body2"
              color={failure ? 'error' : 'text.secondary'}
              sx={{ overflowWrap: 'anywhere' }}
            >
              {STEP_LABELS[step]}: {failure ?? detail}
            </Typography>
          )
        )
      })}

      {short.length > 0 && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" disabled={isPending} onClick={() => retry(true)}>
              Take them anyway
            </Button>
          }
        >
          {short.map(shortfallMessage).join(' ')}
        </Alert>
      )}
      {warnings.map((warning) => (
        <Alert key={warning} severity="info">
          {warning}
        </Alert>
      ))}
      {error && <Alert severity="error">{error}</Alert>}

      {pending.length > 0 && (
        <Box>
          <Button variant="outlined" size="small" disabled={isPending} onClick={() => retry()}>
            {isPending
              ? 'Retrying...'
              : `Retry ${pending.map((step) => STEP_LABELS[step]).join(', ')}`}
          </Button>
        </Box>
      )}
    </Box>
  )
}
