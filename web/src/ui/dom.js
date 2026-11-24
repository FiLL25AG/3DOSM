// Mały pomocnik DOM. Dane OSM trafiają do węzłów tekstowych, nigdy do HTML.
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") element.className = value;
    else if (key in element && key !== "list") element[key] = value;
    else element.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) element.append(child);
  return element;
}

export const osmUrl = (type, id) => `https://www.openstreetmap.org/${type}/${id}`;
export const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
