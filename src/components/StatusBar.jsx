export default function StatusBar({ status, isBusy }) {
  return (
    <section className={`status-bar ${status.type}`}>
      <span className="status-dot" />
      <strong>{isBusy ? '正在处理...' : status.text}</strong>
    </section>
  );
}
