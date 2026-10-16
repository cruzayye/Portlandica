import { useTheme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'

/** Dialogs fill the screen on phones. */
export const useFullScreenDialog = () => {
  const theme = useTheme()
  return useMediaQuery(theme.breakpoints.down('sm'))
}
