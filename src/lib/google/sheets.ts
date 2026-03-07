import { google } from 'googleapis'
import type { NewOrder } from '@/types/orders'

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

export async function appendOrder(order: NewOrder) {
  const sheets = getSheetsClient()
  const created_at = new Date().toISOString()

  const row = [
    created_at,
    order.name,
    order.isBusiness ? 'Yes' : 'No',
    order.isNewBusiness ? 'Yes' : 'No',
    order.isStill ? 'Yes' : 'No',
    order.isSpark ? 'Yes' : 'No',
    order.totalStill ?? '',
    order.totalSpark ?? '',
    order.IsCustomStill ? 'Yes' : 'No',
    order.isCustomSpark ? 'Yes' : 'No',
    order.price ?? '',
    order.isPaid ? 'Yes' : 'No',
    order.createInvoice ? 'Yes' : 'No',
    order.notes ?? '',
  ]

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    range: 'Form Responses!A:O',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  })
}
