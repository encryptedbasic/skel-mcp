from dataclasses import dataclass
from math import ceil
from typing import Generic, Iterable, TypeVar

T = TypeVar('T')


@dataclass(frozen=True)
class Page(Generic[T]):
    items: list[T]
    page: int
    page_size: int
    total: int

    @property
    def page_count(self) -> int:
        return ceil(self.total / self.page_size)

    @property
    def has_next(self) -> bool:
        return self.page + 1 < self.page_count

    @property
    def has_previous(self) -> bool:
        return self.page > 0


def page_bounds(total: int, page: int, page_size: int) -> tuple[int, int]:
    if total < 0:
        raise ValueError('total must be non-negative')
    if page < 0:
        raise ValueError('page must be non-negative')
    if page_size < 1:
        raise ValueError('page_size must be positive')
    start = min(total, page * page_size)
    end = min(total, start + page_size - 1)
    return start, end


def paginate(items: list[T], page: int = 0, page_size: int = 20) -> Page[T]:
    start, end = page_bounds(len(items), page, page_size)
    return Page(items[start:end], page, page_size, len(items))


def collect_page(source: Iterable[T], page: int, page_size: int) -> Page[T]:
    values = list(source)
    return paginate(values, page, page_size)


def page_links(current: int, total_pages: int, radius: int = 2) -> list[int]:
    if total_pages < 0:
        raise ValueError('total_pages must be non-negative')
    if radius < 0:
        raise ValueError('radius must be non-negative')
    if total_pages == 0:
        return []
    current = max(0, min(current, total_pages - 1))
    first = max(0, current - radius)
    last = min(total_pages, current + radius + 1)
    return list(range(first, last))


def parse_page_query(query: dict[str, str], maximum_size: int = 100) -> tuple[int, int]:
    try:
        page = int(query.get('page', '0'))
        size = int(query.get('page_size', '20'))
    except ValueError as error:
        raise ValueError('pagination parameters must be integers') from error
    if page < 0:
        raise ValueError('page must be non-negative')
    if size < 1 or size > maximum_size:
        raise ValueError('page_size is outside the supported range')
    return page, size


def describe_page(page: Page[object]) -> dict[str, int | bool]:
    return {
        'page': page.page,
        'page_size': page.page_size,
        'total': page.total,
        'page_count': page.page_count,
        'has_next': page.has_next,
        'has_previous': page.has_previous,
    }


def iter_pages(items: list[T], page_size: int = 20) -> Iterable[Page[T]]:
    if page_size < 1:
        raise ValueError('page_size must be positive')
    for page in range(ceil(len(items) / page_size)):
        yield paginate(items, page, page_size)
