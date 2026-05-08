import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  title: string
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`Panel crashed: ${this.props.title}`, error, errorInfo)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section className="panel">
          <div className="panel-header compact">
            <div>
              <h2>{this.props.title}</h2>
              <p>这个面板刚才渲染失败了。你可以刷新快照，或者继续查看其他面板。</p>
            </div>
          </div>
        </section>
      )
    }

    return this.props.children
  }
}
