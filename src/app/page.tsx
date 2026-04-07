'use client'

import { useState } from 'react'
import Box from '@mui/material/Box'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import OrderForm from '@/components/OrderForm/OrderForm'
import Inventory from '@/components/Inventory/Inventory'

export default function Home() {
  const [tab, setTab] = useState(0)

  return (
    <Box component="main" sx={{ minHeight: '100vh' }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider', position: 'sticky', top: 0, bgcolor: 'background.paper', zIndex: 1 }}>
        <Tabs value={tab} onChange={(_, val) => setTab(val)} variant="fullWidth">
          { <Tab label="Order Form" /> }
          { <Tab label="Inventory" /> }
          { <Tab label="A.I.P Numbers" /> }
        </Tabs>
      </Box>
      <Box sx={{ p: { xs: 2, sm: 4 }, display: 'flex', justifyContent: 'center' }}>
        {tab === 0 && <OrderForm />}
        {tab === 1 && <Box sx={{ width: '100%', maxWidth: 560 }}><Inventory /></Box>}
        {tab === 2 && (
          <Box sx={{ width: '100%', height: 'calc(100vh - 120px)' }}>
            <iframe
              src="https://portlandica-dashboard.vercel.app/"
              style={{ width: '100%', height: '100%', border: 'none' }}
              title="A.I.P Numbers"
            />
          </Box>
        )}
      </Box>
    </Box>
  )
}
