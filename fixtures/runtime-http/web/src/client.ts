const API = import.meta.env.VITE_API_URL;

export const user = (id: string) => fetch(`${API}/users/${id}`);
export const report = (id: string) => fetch(`${API}/reports/${id}?full=1`);
export const health = () => fetch('/health');
export const ping = () => fetch('https://status.example.com/v1/ping');
export const raw = (url: string) => fetch(url);
