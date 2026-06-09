'use client'

import { useEffect, useState, useTransition } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Paper from '@mui/material/Paper'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import { getInventory, updateInventoryCount, deleteInventoryItem, createInventoryItem } from '@/app/actions/inventory'
import type { Inventory as InventoryType, NewInventory } from '@/types/orders'

const CANS_PER_CASE = 24
const CANS_PER_PALLET = 1440

const defaultNewItem: NewInventory = {
  name: '',
  count: 0,
  isCustom: false,
  isStill: true,
  fillDate: null,
}

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
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newItem, setNewItem] = useState<NewInventory>(defaultNewItem)
  const [addError, setAddError] = useState<string | null>(null)

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

  const handleDelete = () => {
    if (!selected) return
    startTransition(async () => {
      try {
        await deleteInventoryItem(selected.id)
        setItems((prev) => prev.filter((i) => i.id !== selected.id))
        handleClose()
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Failed to delete item')
      }
    })
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

  const handleAdd = () => {
    startTransition(async () => {
      try {
        const created = await createInventoryItem({
          ...newItem,
          count: newItem.count * CANS_PER_CASE,
        })
        setItems((prev) => [...prev, created])
        setShowAddDialog(false)
        setNewItem(defaultNewItem)
        setAddError(null)
      } catch (err) {
        setAddError(err instanceof Error ? err.message : 'Failed to create item')
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
  const newCanCount = newItem.count > 0 ? newItem.count * CANS_PER_CASE : null

  return (
    <>
      <Paper elevation={2} sx={{ p: 3, width: '100%' }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Typography variant="h5" fontWeight={600}>
            Inventory
          </Typography>
          <Button variant="outlined" size="small" onClick={() => setShowAddDialog(true)}>
            Add Item
          </Button>
        </Box>
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
          <Button onClick={handleDelete} color="error" disabled={isPending}>
            Delete
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={handleClose} disabled={isPending}>Cancel</Button>
          <Button onClick={handleSave} variant="contained" disabled={isPending || caseCount === ''}>
            {isPending ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={showAddDialog} onClose={() => setShowAddDialog(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add Inventory Item</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2} pt={1}>
            <TextField
              label="Name"
              value={newItem.name}
              onChange={(e) => setNewItem((prev) => ({ ...prev, name: e.target.value }))}
              fullWidth
              autoFocus
              required
            />
            <Box display="flex" gap={2}>
              <FormControlLabel
                control={
                  <Switch
                    checked={newItem.isStill}
                    onChange={(e) => setNewItem((prev) => ({ ...prev, isStill: e.target.checked }))}
                  />
                }
                label="Still"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={newItem.isCustom}
                    onChange={(e) => setNewItem((prev) => ({ ...prev, isCustom: e.target.checked }))}
                  />
                }
                label="Custom"
              />
            </Box>
            <TextField
              label="Cases"
              type="number"
              value={newItem.count || ''}
              onChange={(e) => setNewItem((prev) => ({ ...prev, count: Number(e.target.value) }))}
              slotProps={{ input: { inputProps: { min: 0 } } }}
              fullWidth
            />
            {newCanCount !== null && (
              <Typography variant="body2" color="text.secondary">
                {newCanCount} cans · {toPallets(newCanCount)}
              </Typography>
            )}
            <TextField
              label="Fill Date"
              type="date"
              value={newItem.fillDate ?? ''}
              onChange={(e) => setNewItem((prev) => ({ ...prev, fillDate: e.target.value || null }))}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {addError && <Alert severity="error">{addError}</Alert>}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setShowAddDialog(false); setNewItem(defaultNewItem); setAddError(null) }} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleAdd} variant="contained" disabled={isPending || !newItem.name}>
            {isPending ? 'Saving...' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export default Inventory
