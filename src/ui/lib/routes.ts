/**
 * Разделы панели владельца.
 *
 * Перечислены данными, а не ветвлениями: новый раздел добавляется строкой
 * таблицы, и ни меню, ни разбор адреса трогать не нужно.
 */

import { BookOpen, Code, Home, Plug, SlidersHorizontal, type LucideIcon } from "lucide-react";

/**
 * Признак раздела. По нему выбирается страница, и он же — ключ в наборе
 * страниц: пропущенный или перепутанный раздел не соберётся.
 */
export type RouteId = "home" | "mcp" | "api" | "knowledge" | "manage";

export interface Route {
  id: RouteId;
  /** Адрес раздела; он же открывается по прямой ссылке. */
  path: string;
  /** Название в меню и в заголовке страницы. */
  title: string;
  icon: LucideIcon;
  /** Раздел, который стоит отдельно внизу меню. */
  pin?: "bottom";
}

export const ROUTES: readonly Route[] = [
  {
    id: "home",
    path: "/",
    title: "Главная",
    icon: Home,
  },
  {
    id: "mcp",
    // Адрес не `/mcp`: по нему отвечает сам MCP-сервер (он же в
    // `run_worker_first`), и страница там не откроется — клиенты ассистента
    // обращаются именно туда, и менять этот адрес нельзя.
    path: "/assistant",
    title: "MCP",
    icon: Plug,
  },
  {
    id: "api",
    path: "/api",
    title: "API",
    icon: Code,
  },
  {
    id: "knowledge",
    path: "/knowledge",
    title: "Знания",
    icon: BookOpen,
  },
  {
    id: "manage",
    path: "/manage",
    title: "Управление",
    icon: SlidersHorizontal,
    // Управление — не про содержимое базы, поэтому стоит особняком внизу.
    pin: "bottom",
  },
];

/** Разделы меню сверху: всё, что показывает содержимое базы. */
export const MENU_ROUTES: readonly Route[] = ROUTES.filter((route) => route.pin !== "bottom");

/** Разделы, закреплённые внизу меню, — управление. */
export const FOOTER_ROUTES: readonly Route[] = ROUTES.filter((route) => route.pin === "bottom");

export interface Matched {
  route: Route;
  /** Идентификатор записи, если адрес указывает на конкретный документ. */
  vodId?: string;
}

/**
 * Разбор адреса: `/knowledge/2873255697` открывает документ этой записи в
 * разделе знаний. Неизвестный адрес отдаёт главную — страница не должна
 * показывать пустоту из-за опечатки в ссылке.
 */
export function matchRoute(pathname: string): Matched {
  const path = pathname.replace(/\/+$/, "") || "/";
  const exact = ROUTES.find((route) => route.path === path);
  if (exact !== undefined) return { route: exact };

  const knowledge = ROUTES.find((route) => route.path === "/knowledge");
  const document = /^\/knowledge\/(\d{1,20})$/.exec(path);
  if (document !== null && knowledge !== undefined) {
    return { route: knowledge, vodId: document[1] as string };
  }
  // Идентификатор испорчен — показываем список знаний, а не выбрасываем
  // человека на главную: раздел он выбрал верно, ошибся только в ссылке.
  if (knowledge !== undefined && path.startsWith("/knowledge/")) {
    return { route: knowledge };
  }

  return { route: ROUTES[0] as Route };
}

/** Адрес документа внутри раздела знаний. */
export function knowledgeDocumentPath(vodId: string): string {
  return `/knowledge/${vodId}`;
}
