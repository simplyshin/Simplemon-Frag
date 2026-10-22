import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';
import { createProject, listProjects } from '../src/services/project.js';

describe('project service', () => {
  it('创建项目并返回完整字段', () => {
    const db = createTestDb();
    const p = createProject(db, '新项目', '描述');
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('新项目');
    expect(p.description).toBe('描述');
    expect(p.created_at).toBeTruthy();
  });

  it('列表按创建顺序返回', () => {
    const db = createTestDb();
    createProject(db, '项目A');
    createProject(db, '项目B');
    const names = listProjects(db).map((p) => p.name);
    expect(names).toEqual(['项目A', '项目B']);
  });

  it('重名项目被拒绝', () => {
    const db = createTestDb();
    createProject(db, '唯一名');
    expect(() => createProject(db, '唯一名')).toThrow(/已存在/);
  });

  it('空名称被拒绝', () => {
    const db = createTestDb();
    expect(() => createProject(db, '   ')).toThrow(/不能为空/);
  });
});
