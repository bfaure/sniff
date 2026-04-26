import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api/client';

interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes?: number;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function ProjectSelector() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<{ id: string | null; name: string | null }>({ id: null, name: null });
  const [open, setOpen] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadProjects = async () => {
    try {
      const data = await api.projects.list();
      setProjects(data.projects);
      setActiveProject(data.active);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowSaveAs(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSaveAs = async () => {
    if (!newName.trim()) return;
    setLoading(true);
    try {
      await api.projects.saveAs(newName.trim());
      setNewName('');
      setShowSaveAs(false);
      await loadProjects();
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      await api.projects.save();
      await loadProjects();
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = async (id: string) => {
    setLoading(true);
    try {
      await api.projects.open(id);
      await loadProjects();
      setOpen(false);
      // Reload the page to refresh all data
      window.location.reload();
    } catch (err) {
      console.error('Open failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleNew = async () => {
    if (!confirm('Create a new empty project? Current unsaved changes will be lost.')) return;
    setLoading(true);
    try {
      await api.projects.newProject();
      await loadProjects();
      setOpen(false);
      window.location.reload();
    } catch (err) {
      console.error('New project failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
    try {
      await api.projects.delete(id);
      await loadProjects();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 flex items-center gap-1.5 border-b border-gray-800"
      >
        <span className="text-gray-600">Project:</span>
        <span className="text-gray-300 truncate flex-1">
          {activeProject.name || 'Unsaved'}
        </span>
        <span className="text-gray-600 text-[10px]">{open ? '\u25B4' : '\u25BE'}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full w-64 bg-gray-900 border border-gray-700 rounded-b shadow-xl z-50 max-h-80 overflow-auto">
          {/* Actions */}
          <div className="flex gap-1 p-2 border-b border-gray-800">
            <button
              onClick={handleNew}
              disabled={loading}
              className="px-2 py-1 rounded text-[10px] bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50"
            >
              New
            </button>
            {activeProject.id && (
              <button
                onClick={handleSave}
                disabled={loading}
                className="px-2 py-1 rounded text-[10px] bg-emerald-900/50 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 disabled:opacity-50"
              >
                Save
              </button>
            )}
            <button
              onClick={() => setShowSaveAs(!showSaveAs)}
              disabled={loading}
              className="px-2 py-1 rounded text-[10px] bg-blue-900/50 hover:bg-blue-900 text-blue-300 border border-blue-800 disabled:opacity-50"
            >
              Save As
            </button>
          </div>

          {/* Save As input */}
          {showSaveAs && (
            <div className="flex gap-1 p-2 border-b border-gray-800">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveAs()}
                placeholder="Project name..."
                autoFocus
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-600"
              />
              <button
                onClick={handleSaveAs}
                disabled={!newName.trim() || loading}
                className="px-2 py-1 rounded text-[10px] bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
              >
                Save
              </button>
            </div>
          )}

          {/* Project list */}
          {projects.length > 0 ? (
            <div>
              {projects.map((proj) => (
                <div
                  key={proj.id}
                  className={`flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-gray-800/50 group ${
                    activeProject.id === proj.id ? 'bg-gray-800' : ''
                  }`}
                >
                  <button
                    onClick={() => handleOpen(proj.id)}
                    disabled={loading || activeProject.id === proj.id}
                    className="flex-1 text-left min-w-0 disabled:cursor-default"
                  >
                    <div className="text-gray-300 truncate flex items-center gap-1">
                      {activeProject.id === proj.id && (
                        <span className="text-emerald-400 text-[10px]">*</span>
                      )}
                      <span className="truncate">{proj.name}</span>
                    </div>
                    <div className="text-[10px] text-gray-600 truncate">
                      {new Date(proj.updatedAt).toLocaleDateString()} · {proj.description || 'No description'}
                    </div>
                  </button>
                  <span className="text-[10px] text-gray-500 font-mono shrink-0 tabular-nums w-16 text-right">
                    {proj.sizeBytes != null ? formatBytes(proj.sizeBytes) : ''}
                  </span>
                  <button
                    onClick={() => handleDelete(proj.id, proj.name)}
                    className={`text-gray-600 hover:text-red-400 text-[10px] shrink-0 w-6 text-right ${
                      activeProject.id === proj.id
                        ? 'invisible'
                        : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    Del
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-4 text-[10px] text-gray-600 text-center">
              No saved projects yet
            </div>
          )}
        </div>
      )}
    </div>
  );
}
