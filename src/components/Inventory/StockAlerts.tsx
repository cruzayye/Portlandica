import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Box from '@mui/material/Box'
import type { Batch } from '@/lib/db/types'
import {
  LOW_STOCK_THRESHOLD_CANS,
  PRODUCT_LABELS,
  lowStock,
  negativeBatches,
  productOf,
} from './stock'
import type { LedgerStatus } from './types'
import { formatCans, formatNumber, toCases } from './units'

type Props = { batches: Batch[]; ledger: LedgerStatus }

/** Warnings for the top of the tab: low house stock, counts below zero, and ledger mismatches. */
const StockAlerts = ({ batches, ledger }: Props) => {
  const low = lowStock(batches)
  const negative = negativeBatches(batches)
  const mismatches = 'mismatches' in ledger ? ledger.mismatches : []
  const ledgerError = 'error' in ledger ? ledger.error : null

  if (!low.length && !negative.length && !mismatches.length && !ledgerError) return null

  return (
    <Box display="flex" flexDirection="column" gap={1} mb={2}>
      {low.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>Low house stock</AlertTitle>
          {low.map(({ product, cans }) => (
            <Box key={product}>
              {PRODUCT_LABELS[product]}: {formatCans(cans)} ({toCases(cans)})
            </Box>
          ))}
          <Box mt={0.5}>Under {formatCans(LOW_STOCK_THRESHOLD_CANS)}. Time to plan a fill.</Box>
        </Alert>
      )}
      {negative.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>Below zero</AlertTitle>
          {negative.map((batch) => (
            <Box key={batch.id}>
              {batch.name} ({PRODUCT_LABELS[productOf(batch)]}): {formatCans(batch.count)}
            </Box>
          ))}
          <Box mt={0.5}>More cans went out than the count had. Recount, then change the count.</Box>
        </Alert>
      )}
      {mismatches.length > 0 && (
        <Alert severity="error">
          <AlertTitle>Counts don&apos;t match their history</AlertTitle>
          {mismatches.map((row) => (
            <Box key={row.batch_id}>
              {row.name ?? `Batch ${row.batch_id}`}: count {formatNumber(row.count)}, history adds
              up to {formatNumber(row.ledger_total)}
            </Box>
          ))}
          <Box mt={0.5}>
            A count changed without being recorded. Check the inventory_ledger_check view in
            Supabase.
          </Box>
        </Alert>
      )}
      {ledgerError && <Alert severity="info">{ledgerError}</Alert>}
    </Box>
  )
}

export default StockAlerts
