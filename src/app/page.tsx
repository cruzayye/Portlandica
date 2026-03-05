import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'

export default function Home() {
  return (
    <Box
      component="main"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
      }}
    >
      <Typography variant="h4" component="h1">
        Hello world
      </Typography>
    </Box>
  )
}
