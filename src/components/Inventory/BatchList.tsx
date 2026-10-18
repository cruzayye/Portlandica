import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import Typography from '@mui/material/Typography'
import type { Batch } from '@/lib/db/types'
import { formatDay, formatPortlandDay } from './dates'
import {
  KIND_LABELS,
  PRODUCT_LABELS,
  archivedBatches,
  groupBatches,
  type BatchGroup,
} from './stock'
import type { CustomerOption } from './types'
import { formatCans, toCases, toPallets } from './units'

type RowProps = {
  batch: Batch
  customerName: string | null
  onOpen: (id: number) => void
}

const BatchRow = ({ batch, customerName, onOpen }: RowProps) => {
  const negative = batch.count < 0
  const filled = formatDay(batch.fillDate)
  const details = [filled ? `Filled ${filled}` : 'No fill date', batch.source]
    .filter(Boolean)
    .join(' · ')

  return (
    <ListItemButton
      divider
      onClick={() => onOpen(batch.id)}
      sx={{ px: 1, gap: 1, alignItems: 'flex-start' }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography fontWeight={500} sx={{ overflowWrap: 'anywhere' }}>
          {batch.name}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {details}
        </Typography>
        {batch.isCustom &&
          (customerName ? (
            <Typography variant="body2" color="text.secondary">
              For {customerName}
            </Typography>
          ) : (
            <Typography variant="body2" color="warning.dark">
              No customer linked
            </Typography>
          ))}
        {(negative || batch.archived_at) && (
          <Box display="flex" gap={0.5} mt={0.5} flexWrap="wrap">
            {negative && <Chip size="small" color="error" label="Below zero" />}
            {batch.archived_at && (
              <Chip size="small" label={`Archived ${formatPortlandDay(batch.archived_at)}`} />
            )}
          </Box>
        )}
      </Box>
      <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
        <Typography fontWeight={600} color={negative ? 'error' : undefined}>
          {formatCans(batch.count)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {toCases(batch.count)}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {toPallets(batch.count)}
        </Typography>
      </Box>
    </ListItemButton>
  )
}

type SectionProps = {
  title: string
  total: number | null
  batches: Batch[]
  customerNames: Map<number, string>
  onOpen: (id: number) => void
}

const BatchSection = ({ title, total, batches, customerNames, onOpen }: SectionProps) => (
  <Box component="section" aria-label={title}>
    <Box
      display="flex"
      justifyContent="space-between"
      alignItems="baseline"
      gap={1}
      sx={{ borderBottom: 2, borderColor: 'divider', pb: 0.5 }}
    >
      <Typography variant="subtitle1" component="h3" fontWeight={600}>
        {title}
      </Typography>
      {total !== null && (
        <Typography
          variant="body2"
          fontWeight={600}
          color={total < 0 ? 'error' : 'text.secondary'}
          sx={{ whiteSpace: 'nowrap' }}
        >
          {formatCans(total)}
        </Typography>
      )}
    </Box>
    <List disablePadding>
      {batches.map((batch) => (
        <BatchRow
          key={batch.id}
          batch={batch}
          customerName={
            batch.customer_id === null ? null : (customerNames.get(batch.customer_id) ?? null)
          }
          onOpen={onOpen}
        />
      ))}
    </List>
  </Box>
)

export const groupTitle = (group: Pick<BatchGroup, 'product' | 'kind'>) =>
  `${PRODUCT_LABELS[group.product]} · ${KIND_LABELS[group.kind]}`

type Props = {
  batches: Batch[]
  customers: CustomerOption[]
  showArchived: boolean
  onOpen: (id: number) => void
}

/** Batches in use, grouped by product and by house stock vs custom cans; archived ones on request. */
const BatchList = ({ batches, customers, showArchived, onOpen }: Props) => {
  const customerNames = new Map(customers.map((customer) => [customer.id, customer.name]))
  const groups = groupBatches(batches)
  const archived = showArchived ? archivedBatches(batches) : []

  return (
    <Box display="flex" flexDirection="column" gap={3}>
      {groups.length === 0 && (
        <Typography color="text.secondary">
          No batches in stock. Add one when cans are filled.
        </Typography>
      )}
      {groups.map((group) => (
        <BatchSection
          key={`${group.product}-${group.kind}`}
          title={groupTitle(group)}
          total={group.cans}
          batches={group.batches}
          customerNames={customerNames}
          onOpen={onOpen}
        />
      ))}
      {archived.length > 0 && (
        <BatchSection
          title="Archived"
          total={null}
          batches={archived}
          customerNames={customerNames}
          onOpen={onOpen}
        />
      )}
    </Box>
  )
}

export default BatchList
