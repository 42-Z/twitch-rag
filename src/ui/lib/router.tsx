/**
 * Переходы между разделами.
 *
 * Свой небольшой переходник вместо библиотеки: разделов пять, нужен только
 * History API и перерисовка на «назад». Настоящие адреса при этом работают —
 * статика уже отдаётся как одностраничное приложение, поэтому прямая ссылка
 * на раздел открывает его, а не главную.
 */

import { useEffect, useState } from "react";

/** Текущий адрес; меняется при переходах и по кнопкам «назад»/«вперёд». */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  return pathname;
}

/** Переход без перезагрузки: история и перерисовка. */
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState({}, "", path);
  // `pushState` не порождает событие, а перерисовать нужно — сообщаем сами.
  window.dispatchEvent(new PopStateEvent("popstate"));
}

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

/**
 * Ссылка раздела. Остаётся обычным `<a href>` — с ним работают средняя кнопка
 * мыши, «открыть в новой вкладке» и копирование адреса, — но обычный клик
 * перехватывается и не перезагружает страницу.
 */
export function Link({ to, onClick, children, ...rest }: LinkProps): React.JSX.Element {
  return (
    <a
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        // Клик с нажатой кнопкой-модификатором оставляем браузеру.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
