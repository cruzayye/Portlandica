'use client'

import { useEffect, useReducer, useState, useTransition } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Snackbar from '@mui/material/Snackbar'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import RefreshIcon from '@mui/icons-material/Refresh'
import { loadInventory } from '@/app/actions/batches'
import { isAuthFailure, type AuthFailure } from '@/lib/auth/authFailure'
import type { Batch } from '@/lib/db/types'
import AddBatchDialog from './AddBatchDialog'
import BatchDialog from './BatchDialog'
import BatchList from './BatchList'
import StockAlerts from './StockAlerts'
import { portlandToday } from './dates'
import { isArchived } from './stock'
import type { InventoryData, LoadResult } from './types'
import { formatCans } from './units'

const LOAD_FAILED = 'Could not load the inventory. Try again.'

type State = { data: InventoryData | null; error: string | null }

type Action =
  | { type: 'loaded'; result: LoadResult | AuthFailure }
  | { type: 'loadFailed' }
  | { type: 'saved'; batch: Batch }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'loaded': {
      const { result } = action
      if (isAuthFailure(result)) return { ...state, error: result.authError }
      if (!result.ok) return { ...state, error: result.error }
      const { batches, customers, ledger } = result
      return { data: { batches, customers, ledger }, error: null }
    }
    case 'loadFailed':
      return { ...state, error: LOAD_FAILED }
    case 'saved': {
      if (!state.data) return state
      const { batch } = action
      const { batches } = state.data
      return {
        ...state,
        data: {
          ...state.data,
          batches: batches.some((b) => b.id === batch.id)
            ? batches.map((b) => (b.id === batch.id ? batch : b))
            : [...batches, batch],
        },
      }
    }
  }
}

/** The Inventory tab: batches on hand, their history, and every change through the ledger. */
const Inventory = () => {
  const [{ data, error }, dispatch] = useReducer(reducer, { data: null, error: null })
  const [refreshing, startRefresh] = useTransition()
  const [showArchived, setShowArchived] = useState(false)
  const [openBatchId, setOpenBatchId] = useState<number | null>(null)
  // The fill date a new batch starts with; set while the Add batch dialog is open.
  const [addingOn, setAddingOn] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    loadInventory()
      .then((result) => {
        if (active) dispatch({ type: 'loaded', result })
      })
      .catch(() => {
        if (active) dispatch({ type: 'loadFailed' })
      })
    return () => {
      active = false
    }
  }, [])

  const refresh = () =>
    startRefresh(async () => {
      try {
        dispatch({ type: 'loaded', result: await loadInventory() })
      } catch {
        dispatch({ type: 'loadFailed' })
      }
    })

  if (!data) {
    return error ? (
      <Alert severity="error">{error}</Alert>
    ) : (
      <Box display="flex" justifyContent="center" pt={6}>
        <CircularProgress aria-label="Loading inventory" />
      </Box>
    )
  }

  const archivedCount = data.batches.filter(isArchived).length
  const openBatch = data.batches.find((batch) => batch.id === openBatchId) ?? null
  const customerName = (batch: Batch) =>
    data.customers.find((customer) => customer.id === batch.customer_id)?.name ?? null

  return (
    <>
      <Paper elevation={2} sx={{ p: { xs: 2, sm: 3 }, width: '100%' }}>
        <Box display="flex" alignItems="center" gap={1} mb={2}>
          <Typography variant="h5" component="h2" fontWeight={600} sx={{ flex: 1 }}>
            Inventory
          </Typography>
          <IconButton aria-label="Refresh" onClick={refresh} disabled={refreshing}>
            <RefreshIcon />
          </IconButton>
          <Button
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setAddingOn(portlandToday())}
          >
            Add batch
          </Button>
        </Box>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <StockAlerts batches={data.batches} ledger={data.ledger} />
        <BatchList
          batches={data.batches}
          customers={data.customers}
          showArchived={showArchived}
          onOpen={setOpenBatchId}
        />
        {archivedCount > 0 && (
          <FormControlLabel
            sx={{ mt: 2 }}
            control={
              <Switch checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            }
            label={`Show archived (${archivedCount})`}
          />
        )}
      </Paper>

      {openBatch && (
        <BatchDialog
          key={openBatch.id}
          batch={openBatch}
          customerName={customerName(openBatch)}
          onClose={() => setOpenBatchId(null)}
          onSaved={(batch) => dispatch({ type: 'saved', batch })}
        />
      )}
      {addingOn !== null && (
        <AddBatchDialog
          customers={data.customers}
          fillDate={addingOn}
          onClose={() => setAddingOn(null)}
          onAdded={(batch) => {
            dispatch({ type: 'saved', batch })
            setAddingOn(null)
            setNotice(`Added ${batch.name}: ${formatCans(batch.count)}`)
          }}
        />
      )}
      <Snackbar
        open={notice !== null}
        autoHideDuration={4000}
        onClose={() => setNotice(null)}
        message={notice}
      />
    </>
  )
}

export default Inventory
