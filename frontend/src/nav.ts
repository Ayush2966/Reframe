export function openProject(id: string | null) {
  window.location.hash = id ? `#/v/${id}` : '#/'
}
