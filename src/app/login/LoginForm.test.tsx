import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SIGN_IN_NOT_SET_UP, WRONG_PASSWORD } from '@/lib/auth/authFailure'

const signIn = vi.fn()

vi.mock('./actions', () => ({
  signIn: (...args: unknown[]) => signIn(...args),
}))

import LoginForm from './LoginForm'

beforeEach(() => {
  signIn.mockReset()
})

describe('LoginForm', () => {
  it('asks for the team password and nothing else', () => {
    const { container } = render(<LoginForm notSetUp={false} />)

    const field = screen.getByLabelText(/team password/i)
    expect(field).toHaveAttribute('type', 'password')
    expect(field).toHaveAttribute('name', 'password')
    expect(container.querySelectorAll('input')).toHaveLength(1)
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/google/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('sends the typed password and shows what went wrong', async () => {
    const user = userEvent.setup()
    signIn.mockResolvedValue({ status: 'error', message: WRONG_PASSWORD })

    render(<LoginForm notSetUp={false} />)
    await user.type(screen.getByLabelText(/team password/i), 'a wrong guess')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText(WRONG_PASSWORD)).toBeInTheDocument()
    const sent = signIn.mock.calls[0][1] as FormData
    expect(sent.get('password')).toBe('a wrong guess')
  })

  it('says sign-in is not set up, and locks the form, when the server settings are wrong', () => {
    render(<LoginForm notSetUp />)

    expect(screen.getByText(SIGN_IN_NOT_SET_UP)).toBeInTheDocument()
    expect(screen.getByLabelText(/team password/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  })
})
