import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    // Enable optimized package imports for MUI
    optimizePackageImports: ['@mui/material', '@mui/icons-material'],
  },
}

export default nextConfig
