import Box from '@mui/material/Box'
import OrderForm from '@/components/OrderForm/OrderForm'

export default function Home() {
  return (
    <Box
      component="main"
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        minHeight: '100vh',
        p: 4,
      }}
    >
      <OrderForm />
    </Box>
  )
}
