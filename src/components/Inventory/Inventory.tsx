'use client'

import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import { getInventory } from '@/app/actions/inventory'
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

  useEffect(() => {
    getInventory()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load inventory'))
      .finally(() => setLoading(false))
  }, [])

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

  return (
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
            sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider' }}
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
  )
}

export default Inventory
