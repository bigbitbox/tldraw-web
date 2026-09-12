import { FormEvent, useState } from 'react'
import { loginWithToken } from '../api'

interface LoginFormProps {
	onSuccess: () => void
}

export function LoginForm({ onSuccess }: LoginFormProps) {
	const [token, setToken] = useState('')
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault()
		const trimmed = token.trim()
		if (!trimmed) {
			setError('请输入访问口令')
			return
		}

		setLoading(true)
		setError(null)
		try {
			const res = await loginWithToken(trimmed)
			if (res.ok) {
				onSuccess()
			} else {
				setError(res.error || '访问口令无效，请重试')
			}
		} catch (err: any) {
			setError(err?.message || '登录异常，请重试')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="auth-overlay">
			<div className="auth-card">
				<div className="auth-header">
					<div className="auth-icon-wrap">
						<svg
							className="auth-icon"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
							<path d="M7 11V7a5 5 0 0 1 10 0v4" />
						</svg>
					</div>
					<h2 className="auth-title">访问验证</h2>
					<p className="auth-subtitle">请输入访问口令进入白板工作区</p>
				</div>

				<form onSubmit={handleSubmit} className="auth-form">
					<div className="auth-field">
						<input
							type="password"
							className="auth-input"
							placeholder="输入访问口令 (Token)"
							value={token}
							onChange={(e) => {
								setToken(e.target.value)
								if (error) setError(null)
							}}
							autoFocus
							disabled={loading}
						/>
					</div>

					{error && (
						<div className="auth-error">
							<span>{error}</span>
							<button
								type="button"
								className="auth-retry-btn"
								onClick={() => {
									setError(null)
									setToken('')
								}}
							>
								重试
							</button>
						</div>
					)}

					<button type="submit" className="auth-submit-btn" disabled={loading || !token.trim()}>
						{loading ? '正在验证...' : '进入工作区'}
					</button>
				</form>
			</div>
		</div>
	)
}
