import type { sheets_v4 } from 'googleapis'

// An in-memory stand-in for the parts of the Sheets API the app uses. It keeps each tab
// as rows of cells and applies writes for real: inserted rows push later rows (and their
// metadata tags) down, batchUpdate is all or nothing, and reads come back the way the
// API formats them (dates in Sales and Donations column A as mm/dd/yyyy). Formula
// references are stored as written; the real sheet would also shift them on insert.

/** A cell: a number, text, or a formula (text starting with '='). Empty is ''. */
export type FakeCell = string | number

type Tag = { id: number; key: string; value: string; sheetId: number; index: number }
type Tab = { sheetId: number; rows: FakeCell[][] }
type Method =
  | 'get'
  | 'batchUpdate'
  | 'values.get'
  | 'values.update'
  | 'values.append'
  | 'developerMetadata.search'

const DATE_COLUMNS: Record<string, number[]> = { Sales: [0, 7], Donations: [0] }

const columnIndex = (letters: string) =>
  [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1

const parseRange = (range: string) => {
  const match = /^(?:'([^']+)'|([^!]+))!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(range)
  if (!match) throw new Error(`fakeSheets: can't read range ${range}`)
  const [, quoted, plain, fromCol, fromRow, toCol, toRow] = match
  return {
    tab: quoted ?? plain,
    fromCol: columnIndex(fromCol),
    toCol: columnIndex(toCol ?? fromCol),
    fromRow: fromRow ? Number(fromRow) - 1 : 0,
    toRow: toRow ? Number(toRow) - 1 : fromRow ? Number(fromRow) - 1 : Infinity,
  }
}

const serialToDate = (serial: number) => {
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()}`
}

const cellFrom = (data: sheets_v4.Schema$CellData | undefined): FakeCell => {
  const value = data?.userEnteredValue
  if (!value) return ''
  if (value.formulaValue != null) return value.formulaValue
  if (value.numberValue != null) return value.numberValue
  return value.stringValue ?? ''
}

export const createFakeSheets = (initial: Record<string, FakeCell[][]>) => {
  let nextSheetId = 100
  let nextTagId = 1
  let tabs = new Map<string, Tab>(
    Object.entries(initial).map(([title, rows]) => [
      title,
      { sheetId: nextSheetId++, rows: rows.map((row) => [...row]) },
    ])
  )
  let tags: Tag[] = []
  const failures = new Map<Method, Error[]>()
  const calls: { method: Method; detail?: unknown }[] = []
  const formats: sheets_v4.Schema$RepeatCellRequest[] = []

  const tabNamed = (title: string, state = tabs) => {
    const tab = state.get(title)
    if (!tab) throw new Error(`fakeSheets: no tab ${title}`)
    return tab
  }
  const tabById = (sheetId: number | null | undefined, state = tabs) => {
    const entry = [...state.entries()].find(([, tab]) => tab.sheetId === sheetId)
    if (!entry) throw new Error(`fakeSheets: no sheet ${sheetId}`)
    return entry
  }

  const call = async (method: Method, detail?: unknown) => {
    calls.push({ method, detail })
    // Let other callers run between API calls, as real requests would.
    await Promise.resolve()
    const queued = failures.get(method)
    if (queued?.length) throw queued.shift()
  }

  const display = (title: string, cell: FakeCell, column: number) =>
    typeof cell === 'number'
      ? DATE_COLUMNS[title]?.includes(column)
        ? serialToDate(cell)
        : String(cell)
      : cell

  const applyRequest = (
    state: Map<string, Tab>,
    stateTags: Tag[],
    request: sheets_v4.Schema$Request
  ): Tag[] => {
    if (request.insertDimension) {
      const { sheetId, startIndex, endIndex } = request.insertDimension.range!
      const [, tab] = tabById(sheetId, state)
      const count = endIndex! - startIndex!
      while (tab.rows.length < startIndex!) tab.rows.push([])
      tab.rows.splice(startIndex!, 0, ...Array.from({ length: count }, () => []))
      return stateTags.map((tag) =>
        tag.sheetId === sheetId && tag.index >= startIndex!
          ? { ...tag, index: tag.index + count }
          : tag
      )
    }
    if (request.repeatCell) {
      formats.push(request.repeatCell)
      return stateTags
    }
    if (request.updateCells) {
      const { start, rows } = request.updateCells
      const [, tab] = tabById(start!.sheetId, state)
      rows!.forEach((row, i) => {
        const r = start!.rowIndex! + i
        while (tab.rows.length <= r) tab.rows.push([])
        const target = tab.rows[r]
        ;(row.values ?? []).forEach((cell, j) => {
          const c = (start!.columnIndex ?? 0) + j
          while (target.length <= c) target.push('')
          target[c] = cellFrom(cell)
        })
      })
      return stateTags
    }
    if (request.createDeveloperMetadata) {
      const metadata = request.createDeveloperMetadata.developerMetadata!
      const range = metadata.location!.dimensionRange!
      if (range.endIndex! - range.startIndex! !== 1) {
        throw new Error('fakeSheets: row metadata must cover exactly one row')
      }
      return [
        ...stateTags,
        {
          id: nextTagId++,
          key: metadata.metadataKey!,
          value: metadata.metadataValue!,
          sheetId: range.sheetId!,
          index: range.startIndex!,
        },
      ]
    }
    if (request.deleteDeveloperMetadata) {
      const lookup = request.deleteDeveloperMetadata.dataFilter!.developerMetadataLookup!
      return stateTags.filter(
        (tag) => !(tag.key === lookup.metadataKey && tag.value === lookup.metadataValue)
      )
    }
    throw new Error(`fakeSheets: unsupported request ${Object.keys(request).join(', ')}`)
  }

  const api = {
    spreadsheets: {
      get: async () => {
        await call('get')
        return {
          data: {
            sheets: [...tabs.entries()].map(([title, tab]) => ({
              properties: { title, sheetId: tab.sheetId },
            })),
          },
        }
      },
      batchUpdate: async ({
        requestBody,
      }: {
        requestBody: { requests: sheets_v4.Schema$Request[] }
      }) => {
        await call('batchUpdate', requestBody.requests)
        // All or nothing, like the real API.
        const state = new Map(
          [...tabs.entries()].map(([title, tab]) => [
            title,
            { sheetId: tab.sheetId, rows: tab.rows.map((row) => [...row]) },
          ])
        )
        let stateTags = [...tags]
        for (const request of requestBody.requests) {
          stateTags = applyRequest(state, stateTags, request)
        }
        tabs = state
        tags = stateTags
        return { data: {} }
      },
      values: {
        get: async ({ range }: { range: string }) => {
          await call('values.get', range)
          const { tab: title, fromCol, toCol, fromRow, toRow } = parseRange(range)
          const rows = tabNamed(title).rows.slice(
            fromRow,
            toRow === Infinity ? undefined : toRow + 1
          )
          const values = rows.map((row) =>
            row.slice(fromCol, toCol + 1).map((cell, j) => display(title, cell, fromCol + j))
          )
          // The API leaves off trailing empty cells and rows.
          const trimmed = values.map((row) => {
            const copy = [...row]
            while (copy.length && copy[copy.length - 1] === '') copy.pop()
            return copy
          })
          while (trimmed.length && !trimmed[trimmed.length - 1].length) trimmed.pop()
          return { data: { values: trimmed } }
        },
        update: async ({
          range,
          requestBody,
        }: {
          range: string
          requestBody: { values: FakeCell[][] }
        }) => {
          await call('values.update', { range, values: requestBody.values })
          const { tab: title, fromCol, fromRow } = parseRange(range)
          const tab = tabNamed(title)
          requestBody.values.forEach((row, i) => {
            while (tab.rows.length <= fromRow + i) tab.rows.push([])
            const target = tab.rows[fromRow + i]
            row.forEach((cell, j) => {
              while (target.length <= fromCol + j) target.push('')
              target[fromCol + j] = cell
            })
          })
          return { data: {} }
        },
        append: async ({
          range,
          requestBody,
        }: {
          range: string
          requestBody: { values: FakeCell[][] }
        }) => {
          await call('values.append', { range, values: requestBody.values })
          const tab = tabNamed(parseRange(range).tab)
          let last = tab.rows.length - 1
          while (last >= 0 && !tab.rows[last].some((cell) => cell !== '')) last--
          tab.rows.splice(last + 1, 0, ...requestBody.values.map((row) => [...row]))
          return { data: {} }
        },
      },
      developerMetadata: {
        search: async ({
          requestBody,
        }: {
          requestBody: { dataFilters: sheets_v4.Schema$DataFilter[] }
        }) => {
          await call('developerMetadata.search')
          const lookup = requestBody.dataFilters[0].developerMetadataLookup!
          const matched = tags
            .filter((tag) => tag.key === lookup.metadataKey && tag.value === lookup.metadataValue)
            .map((tag) => ({
              developerMetadata: {
                metadataId: tag.id,
                metadataKey: tag.key,
                metadataValue: tag.value,
                location: {
                  locationType: 'ROW',
                  dimensionRange: {
                    sheetId: tag.sheetId,
                    dimension: 'ROWS',
                    startIndex: tag.index,
                    endIndex: tag.index + 1,
                  },
                },
              },
            }))
          return { data: { matchedDeveloperMetadata: matched.length ? matched : undefined } }
        },
      },
    },
  }

  return {
    api: api as unknown as sheets_v4.Sheets,
    /** A tab's cells as stored (numbers, text and formulas). */
    rows: (title: string) => tabNamed(title).rows,
    /** Row metadata tags, with their current rows (0-based). */
    tags: () => [...tags],
    calls,
    formats,
    /** Make the next call of this method fail. */
    failNext: (method: Method, error = new Error(`${method} failed`)) => {
      failures.set(method, [...(failures.get(method) ?? []), error])
    },
  }
}

export type FakeSheets = ReturnType<typeof createFakeSheets>
