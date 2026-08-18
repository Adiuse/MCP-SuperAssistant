import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface PopoverPortalProps {
  children: React.ReactNode;
  isOpen: boolean;
  triggerRef: React.RefObject<any>;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const PopoverPortal: React.FC<PopoverPortalProps> = ({ children, isOpen, triggerRef, onMouseEnter, onMouseLeave }) => {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragHandleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!portalContainer) {
      const div = document.createElement('div');
      div.id = 'mcp-popover-portal';
      div.style.position = 'absolute';
      div.style.zIndex = '10000';
      div.style.top = '0';
      div.style.left = '0';
      document.body.appendChild(div);
      setPortalContainer(div);
    }

    return () => {
      if (portalContainer && document.body.contains(portalContainer)) {
        document.body.removeChild(portalContainer);
      }
    };
  }, [portalContainer]);

  useEffect(() => {
    const updatePosition = () => {
      if (isOpen && portalContainer && triggerRef.current && !isDragging) {
        const triggerRect = triggerRef.current.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const taskbarSafePadding = 56;

        const popoverElement = portalContainer.firstElementChild?.firstElementChild as HTMLElement;
        if (!popoverElement) return;

        const popoverWidth = popoverElement.offsetWidth;
        const popoverHeight = popoverElement.offsetHeight;

        let left = triggerRect.left + triggerRect.width / 2;
        let top = triggerRect.top - 10;
        let transform = 'translate(-50%, -100%)';
        let transformOrigin = 'center bottom';

        if (left - popoverWidth / 2 < 10) left = popoverWidth / 2 + 10;
        if (left + popoverWidth / 2 > viewportWidth - 10) left = viewportWidth - popoverWidth / 2 - 10;

        const availableHeight = viewportHeight - taskbarSafePadding;
        const spaceAbove = triggerRect.top;
        const spaceBelow = availableHeight - triggerRect.bottom;

        if (triggerRect.top < popoverHeight + 30 || (spaceAbove < popoverHeight + 20 && spaceBelow >= popoverHeight + 20)) {
          top = Math.min(triggerRect.bottom + 10, availableHeight - popoverHeight - 10);
          transform = 'translate(-50%, 0)';
          transformOrigin = 'center top';
        } else {
          top = triggerRect.top - 10;
          if (top - popoverHeight < 10) top = popoverHeight + 10;
        }

        portalContainer.style.position = 'fixed';
        portalContainer.style.left = `${left}px`;
        portalContainer.style.top = `${top}px`;
        portalContainer.style.transform = transform;

        setPosition({ x: left, y: top });
        popoverElement.style.transformOrigin = transformOrigin;
      }
    };

    if (isOpen && portalContainer && triggerRef.current) {
      updatePosition();
      window.addEventListener('scroll', updatePosition);
      window.addEventListener('resize', updatePosition);
      return () => {
        window.removeEventListener('scroll', updatePosition);
        window.removeEventListener('resize', updatePosition);
      };
    }
    return undefined;
  }, [isOpen, portalContainer, triggerRef, isDragging]);

  const handleDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!portalContainer) return;
    setIsDragging(true);
    const rect = portalContainer.getBoundingClientRect();
    setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    e.preventDefault();
  };

  const handleDragMove = (e: MouseEvent) => {
    if (!isDragging || !portalContainer) return;
    const left = e.clientX - dragOffset.x;
    const top = e.clientY - dragOffset.y;
    portalContainer.style.left = `${left}px`;
    portalContainer.style.top = `${top}px`;
    portalContainer.style.transform = 'none';
    setPosition({ x: left, y: top });
  };

  const handleDragEnd = () => setIsDragging(false);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup', handleDragEnd);
    }
    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
    };
  }, [isDragging]);

  if (!portalContainer || !isOpen) return null;

  return createPortal(
    <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} style={{ display: 'contents' }}>
      <div className="mcp-popover-wrapper" style={{ position: 'relative', opacity: isDragging ? 0.9 : 1 }}>
        {children}
        <div ref={dragHandleRef} className="mcp-drag-handle" onMouseDown={handleDragStart} title="Drag to move" />
      </div>
    </div>,
    portalContainer,
  );
};

export default PopoverPortal;
