declare const API_URL: string;
declare function useState<T>(): [T | undefined, (value: T) => void];
declare function useEffect(effect: () => () => void, deps: unknown[]): void;

// #region show
export function useClicks(code: string) {
  const [clicks, setClicks] = useState<number>();
  useEffect(() => {
    const socket = new WebSocket(`${API_URL}/${code}/live`);
    socket.onmessage = (event) => setClicks(JSON.parse(event.data).clicks);
    return () => socket.close();
  }, [code]);
  return clicks;
}
// #endregion show
