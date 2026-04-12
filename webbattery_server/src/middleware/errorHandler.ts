import { Request, Response, NextFunction } from 'express';

// Error interface
interface AppError extends Error {
  statusCode?: number;
}

// Error handler middleware
export function errorHandler(
  err: AppError, 
  req: Request, 
  res: Response, 
  next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  
  console.error(`[ERROR] ${err.message}`);
  if (err.stack) {
    console.error(err.stack);
  }
  
  res.status(statusCode).json({
    success: false,
    error: err.message || 'Internal Server Error',
    path: req.path
  });
}

// Not found middleware
export function notFound(
  req: Request, 
  res: Response, 
  next: NextFunction
): void {
  const error: AppError = new Error(`Not Found - ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
}

// Async handler to catch async errors
export const asyncHandler = (fn: Function) => (
  req: Request, 
  res: Response, 
  next: NextFunction
) => {
  Promise.resolve(fn(req, res, next)).catch(next);
}; 