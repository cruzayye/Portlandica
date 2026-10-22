import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { SIGNED_OUT } from '@/lib/auth/authFailure'
import { AIP_NOT_SET_UP } from '@/lib/aip'

const getAipNumbers = vi.fn()

vi.mock('@/app/actions/aip', () => ({
  getAipNumbers: () => getAipNumbers(),
}))

import AipNumbers, { AIP_PAGE } from './AipNumbers'

const DATA = '{"generated":"2026-10-18T12:00:00.000Z"}'

/** Renders the tab, "loads" the sandboxed page and spies on what is posted to it. */
const renderLoaded = async () => {
  render(<AipNumbers />)
  const frame = screen.getByTitle('A.I.P Numbers') as HTMLIFrameElement
  const posted = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => {
    fireEvent.load(frame)
  })
  return { frame, posted }
}

const messagesTo = (posted: { mock: { calls: unknown[][] } }) =>
  posted.mock.calls.map(([message, target]) => ({ message, target }))

const sendFrom = (source: Window, data: unknown) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })

beforeEach(() => {
  getAipNumbers.mockReset()
})

describe('AipNumbers', () => {
  it('draws the dashboard page in a frame sandboxed away from the app', () => {
    getAipNumbers.mockResolvedValue({ json: DATA })
    render(<AipNumbers />)
    const frame = screen.getByTitle('A.I.P Numbers')
    expect(frame.getAttribute('src')).toBe(AIP_PAGE)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  })

  it('fetches the numbers once the page loads and posts them to it', async () => {
    getAipNumbers.mockResolvedValue({ json: DATA })
    const { posted } = await renderLoaded()

    expect(getAipNumbers).toHaveBeenCalledTimes(1)
    expect(messagesTo(posted)).toEqual([
      { message: { type: 'aip:loading' }, target: '*' },
      { message: { type: 'aip:data', json: DATA }, target: '*' },
    ])
  })

  it('tells the page when the session has ended', async () => {
    getAipNumbers.mockResolvedValue({ authError: SIGNED_OUT })
    const { posted } = await renderLoaded()
    expect(messagesTo(posted).at(-1)?.message).toEqual({ type: 'aip:error', message: SIGNED_OUT })
  })

  it('passes on what went wrong with the spreadsheet', async () => {
    getAipNumbers.mockResolvedValue({ error: 'The spreadsheet took too long to respond. Try again.' })
    const { posted } = await renderLoaded()
    expect(messagesTo(posted).at(-1)?.message).toEqual({
      type: 'aip:error',
      message: 'The spreadsheet took too long to respond. Try again.',
    })
  })

  it('says the connection failed when the server action itself fails', async () => {
    getAipNumbers.mockRejectedValue(new Error('network down'))
    const { posted } = await renderLoaded()
    expect(messagesTo(posted).at(-1)?.message).toEqual({
      type: 'aip:error',
      message: 'Could not load the numbers. Check the connection and try again.',
    })
  })

  it('refreshes when the page asks, and ignores messages from anywhere else', async () => {
    getAipNumbers.mockResolvedValue({ json: DATA })
    const { frame } = await renderLoaded()

    await sendFrom(window, { type: 'aip:refresh' })
    await sendFrom(frame.contentWindow!, { type: 'something-else' })
    expect(getAipNumbers).toHaveBeenCalledTimes(1)

    await sendFrom(frame.contentWindow!, { type: 'aip:refresh' })
    expect(getAipNumbers).toHaveBeenCalledTimes(2)
  })

  it('says so in the page when the app is not connected to the spreadsheet', async () => {
    getAipNumbers.mockResolvedValue({ error: AIP_NOT_SET_UP, notSetUp: true })
    const { frame, posted } = await renderLoaded()

    expect(messagesTo(posted).at(-1)?.message).toEqual({ type: 'aip:error', message: AIP_NOT_SET_UP })
    expect(frame.getAttribute('src')).toBe(AIP_PAGE)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  })
})
