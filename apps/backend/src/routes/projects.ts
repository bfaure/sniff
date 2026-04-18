import type { FastifyInstance } from 'fastify';
import { projectManager } from '../projects/manager.js';
import { loadModelOverrides } from '../llm/client.js';

export function projectRoutes(fastify: FastifyInstance): void {
  // List all projects
  fastify.get('/api/projects', async () => {
    return {
      projects: projectManager.list(),
      active: projectManager.getActive(),
    };
  });

  // Create new project from current state (Save As)
  fastify.post('/api/projects', async (req) => {
    const { name, description } = req.body as { name: string; description?: string };
    const project = await projectManager.saveAs(name, description || '');
    return project;
  });

  // Save current project
  fastify.post('/api/projects/save', async () => {
    const saved = await projectManager.save();
    return { saved };
  });

  // Open a project
  fastify.post('/api/projects/:id/open', async (req) => {
    const { id } = req.params as { id: string };
    const project = await projectManager.open(id);
    if (!project) throw new Error('Project not found');
    // Reload model overrides from the new DB
    await loadModelOverrides().catch(() => {});
    return project;
  });

  // New empty project (clear current)
  fastify.post('/api/projects/new', async () => {
    await projectManager.newProject();
    return { status: 'ok' };
  });

  // Rename a project
  fastify.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { name, description } = req.body as { name: string; description?: string };
    const project = await projectManager.rename(id, name, description);
    if (!project) throw new Error('Project not found');
    return project;
  });

  // Delete a project
  fastify.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const deleted = await projectManager.deleteProject(id);
    return { deleted };
  });
}
