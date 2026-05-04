'use client'

import { useEffect, useState, useTransition } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Paper from '@mui/material/Paper'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import { getInventory, updateInventoryCount } from '@/app/actions/inventory'
import type { Inventory as InventoryType } from '@/types/orders'

const CANS_PER_CASE = 24
const CANS_PER_PALLET = 1440

const toCases = (count: number) => {
  const cases = count / CANS_PER_CASE
  return `${+cases.toFixed(2)} case${cases === 1 ? '' : 's'}`
}

const toPallets = (count: number) => {
  const pallets = count / CANS_PER_PALLET
  return `${+pallets.toFixed(2)} pallet${pallets === 1 ? '' : 's'}`
}

const Inventory = () => {
  const [items, setItems] = useState<InventoryType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<InventoryType | null>(null)
  const [caseCount, setCaseCount] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    getInventory()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load inventory'))
      .finally(() => setLoading(false))
  }, [])

  const handleOpen = (item: InventoryType) => {
    setSelected(item)
    setCaseCount(String(item.count / CANS_PER_CASE))
    setSaveError(null)
  }

  const handleClose = () => {
    setSelected(null)
    setCaseCount('')
    setSaveError(null)
  }

  const handleSave = () => {
    if (!selected) return
    const count = Number(caseCount) * CANS_PER_CASE
    startTransition(async () => {
      try {
        await updateInventoryCount(selected.id, count)
        setItems((prev) => prev.map((i) => (i.id === selected.id ? { ...i, count } : i)))
        handleClose()
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to update count')
      }
    })
  }

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" pt={6}>
        <CircularProgress />
      </Box>
    )
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>
  }

  const canCount = caseCount !== '' ? Number(caseCount) * CANS_PER_CASE : null

  return (
    <>
      <Paper elevation={2} sx={{ p: 3, width: '100%' }}>
        <Typography variant="h5" fontWeight={600} mb={3}>
          Inventory
        </Typography>
        <Box display="flex" flexDirection="column" gap={1}>
          {items.map((item) => (
            <Box
              key={item.id}
              display="flex"
              justifyContent="space-between"
              alignItems="center"
              onClick={() => handleOpen(item)}
              sx={{
                py: 1,
                borderBottom: '1px solid',
                borderColor: 'divider',
                cursor: 'pointer',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Box>
                <Typography variant="body1">{item.name}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {item.isStill ? 'Still' : 'Spark'}
                </Typography>
                {item.isCustom && (
                  <Typography variant="caption" color="text.secondary">
                    Custom |
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" fontWeight="bold">
                  {` ${item.fillDate}`}
                </Typography>
              </Box>
              <Box display="flex" flexDirection="column" alignItems="flex-end">
                <Typography variant="body1" fontWeight={500}>
                  {toPallets(item.count)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {toCases(item.count)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {item.count}
                </Typography>
              </Box>
            </Box>
          ))}
          {items.length === 0 && (
            <Typography color="text.secondary">No inventory items found.</Typography>
          )}
        </Box>
      </Paper>

      <Dialog open={!!selected} onClose={handleClose} fullWidth maxWidth="xs">
        <DialogTitle>
          Update Count — {selected?.name} {selected?.isStill ? 'Still' : 'Spark'}
        </DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2} pt={1}>
            <TextField
              label="Cases"
              type="number"
              value={caseCount}
              onChange={(e) => setCaseCount(e.target.value)}
              slotProps={{ input: { inputProps: { min: 0 } } }}
              fullWidth
              autoFocus
            />
            {canCount !== null && (
              <Typography variant="body2" color="text.secondary">
                {canCount} cans · {toPallets(canCount)}
              </Typography>
            )}
            {saveError && <Alert severity="error">{saveError}</Alert>}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} variant="contained" disabled={isPending || caseCount === ''}>
            {isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export default Inventory
